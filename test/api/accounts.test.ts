import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { balanceOf, makeApp, newAccount, randomDocument, setStatus } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
afterEach(() => vi.restoreAllMocks());

const mask = (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/accounts', payload: payload as object });
const patchStatus = (id: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/accounts/${id}/status`, payload: payload as object });

describe('POST /accounts', () => {
  it('POST /accounts → 201 ACTIVE with balance 0', async () => {
    const doc = randomDocument();
    const res = await post({ holderName: '  João da Silva ', document: mask(doc) });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      holderName: 'João da Silva',
      document: doc,
      status: 'ACTIVE',
      balance: 0,
    });
    expect(res.headers.location).toBe(`/accounts/${body.id}`);
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  });

  it('duplicate document (masked vs unmasked) → 409 DOCUMENT_ALREADY_EXISTS', async () => {
    const doc = randomDocument();
    expect((await post({ holderName: 'A', document: doc })).statusCode).toBe(201);
    const res = await post({ holderName: 'B', document: mask(doc) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DOCUMENT_ALREADY_EXISTS');
    expect(res.body).not.toContain(doc); // the pg error detail echoes the key; it must not reach the client
  });

  it('5 parallel creates with the same document → exactly one 201, four 409', async () => {
    const doc = randomDocument();
    const codes = (
      await Promise.all(Array.from({ length: 5 }, () => post({ holderName: 'X', document: doc })))
    )
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
  });

  it.each([
    [{ document: '12345678900' }],
    [{ holderName: '   ', document: '12345678900' }],
    [{ holderName: 'X'.repeat(121), document: '12345678900' }],
    [{ holderName: 'a\u0000b', document: '12345678900' }], // Postgres rejects NUL (22021): must be 400, not 500
    [{ holderName: 'X', document: 'abc' }],
    [{ holderName: 'X', document: '12345678900', balance: 1000 }],
    [{ holderName: 'X', document: '12345678900', status: 'BLOCKED' }],
  ])('invalid body %j → 400 VALIDATION_ERROR', async (payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('malformed JSON → 400 VALIDATION_ERROR without parser internals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'content-type': 'application/json' },
      payload: '{"holderName":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.body).not.toMatch(/SyntaxError|at JSON\.parse/);
  });

  it('text/plain body → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'content-type': 'text/plain' },
      payload: 'holderName=X',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('GET /accounts/:id', () => {
  it('GET /accounts/:id → 200 with id, holderName, status, balance, createdAt', async () => {
    const id = await newAccount(app, 'Maria');
    const res = await app.inject({ method: 'GET', url: `/accounts/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id,
      holderName: 'Maria',
      document: expect.stringMatching(/^\d{11}$/),
      status: 'ACTIVE',
      balance: 0,
      createdAt: expect.any(String),
    });
  });

  it('GET unknown account → 404 ACCOUNT_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: `/accounts/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('GET /accounts/not-a-uuid → 400 VALIDATION_ERROR (never 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounts/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('unexpected error → 500 INTERNAL_ERROR without the original message', async () => {
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('secret detail'));
    const res = await app.inject({ method: 'GET', url: `/accounts/${randomUUID()}` });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('secret detail');
  });
});

describe('PATCH /accounts/:id/status', () => {
  const statusOf = async (id: string) =>
    (await app.inject({ method: 'GET', url: `/accounts/${id}` })).json().status;

  it('PATCH status ACTIVE→BLOCKED→ACTIVE → 200 each, GET reflects it', async () => {
    const id = await newAccount(app);
    const blocked = await patchStatus(id, { status: 'BLOCKED' });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().status).toBe('BLOCKED');
    expect(await statusOf(id)).toBe('BLOCKED');
    const active = await patchStatus(id, { status: 'ACTIVE' });
    expect(active.statusCode).toBe(200);
    expect(active.json().status).toBe('ACTIVE');
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  // Compared as text: a Date would round the microseconds away.
  const updatedAt = async (id: string) =>
    (await pool.query('SELECT updated_at::text AS t FROM accounts WHERE id = $1', [id])).rows[0].t;

  it.each(['ACTIVE', 'CLOSED'] as const)('PATCH same status %s → 200 no-op', async (status) => {
    const id = await newAccount(app);
    if (status !== 'ACTIVE') await setStatus(app, id, status);
    const before = await updatedAt(id);
    const res = await patchStatus(id, { status });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status });
    expect(await updatedAt(id)).toBe(before); // the UPDATE was skipped
  });

  it('PATCH to CLOSED with zero balance → 200; then PATCH ACTIVE → 422 ACCOUNT_CLOSED', async () => {
    const id = await newAccount(app);
    await setStatus(app, id, 'CLOSED');
    const res = await patchStatus(id, { status: 'ACTIVE' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('ACCOUNT_CLOSED');
    expect(await statusOf(id)).toBe('CLOSED');
  });

  it('PATCH to CLOSED with balance > 0 → 422 ACCOUNT_HAS_BALANCE, status unchanged', async () => {
    const id = await newAccount(app);
    await pool.query('UPDATE accounts SET balance_cents = 100 WHERE id = $1', [id]); // no deposit endpoint yet
    const res = await patchStatus(id, { status: 'CLOSED' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('ACCOUNT_HAS_BALANCE');
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await balanceOf(app, id)).toBe(1);
  });

  it.each(['FROZEN', 'blocked', '', null])('PATCH status %j → 400', async (status) => {
    const id = await newAccount(app);
    const res = await patchStatus(id, { status });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('PATCH with a missing or extra field → 400', async () => {
    const id = await newAccount(app);
    expect((await patchStatus(id, {})).statusCode).toBe(400);
    expect((await patchStatus(id, { status: 'BLOCKED', balance: 5 })).statusCode).toBe(400);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('PATCH unknown account → 404; invalid uuid → 400', async () => {
    const unknown = await patchStatus(randomUUID(), { status: 'BLOCKED' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('ACCOUNT_NOT_FOUND');
    expect((await patchStatus('not-a-uuid', { status: 'BLOCKED' })).statusCode).toBe(400);
  });
});
