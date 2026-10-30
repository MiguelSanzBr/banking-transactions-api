import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { balanceOf, depositTo, makeApp, newAccount, setStatus, waitForQueue } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const post = (accountId: string, payload: unknown, idempotencyKey?: string) =>
  app.inject({
    method: 'POST',
    url: `/accounts/${accountId}/deposits`,
    payload: payload as object,
    headers: idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
  });
const countByKey = async (key: string) =>
  Number(
    (await pool.query('SELECT count(*) FROM deposits WHERE idempotency_key = $1', [key])).rows[0]
      .count,
  );

describe('POST /accounts/:accountId/deposits', () => {
  it('deposit → 201 {id, accountId, amount, createdAt}; balance increases', async () => {
    const a = await newAccount(app);
    const res = await post(a, { amount: 500.0 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ accountId: a, amount: 500 });
    expect(new Date(res.json().createdAt).toISOString()).toBe(res.json().createdAt);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await balanceOf(app, a)).toBe(500);
  });

  it('ten deposits of 0.10 → balance exactly 1', async () => {
    const a = await newAccount(app);
    for (let i = 0; i < 10; i++) await depositTo(app, a, 0.1);
    expect(await balanceOf(app, a)).toBe(1);
  });

  it('BLOCKED account can receive a deposit → 201', async () => {
    const a = await newAccount(app);
    await setStatus(app, a, 'BLOCKED');
    expect((await post(a, { amount: 10 })).statusCode).toBe(201);
    expect(await balanceOf(app, a)).toBe(10);
  });

  it('CLOSED account → 422 ACCOUNT_CLOSED', async () => {
    const a = await newAccount(app);
    await setStatus(app, a, 'CLOSED');
    const res = await post(a, { amount: 10 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('ACCOUNT_CLOSED');
    expect(await balanceOf(app, a)).toBe(0);
  });

  it.each([
    [0, 422, 'INVALID_AMOUNT'],
    [-10, 422, 'INVALID_AMOUNT'],
    [10.005, 400, 'VALIDATION_ERROR'],
    ['100', 400, 'VALIDATION_ERROR'],
    [null, 400, 'VALIDATION_ERROR'],
  ])('amount %j → %s %s', async (amount, status, code) => {
    const a = await newAccount(app);
    const res = await post(a, { amount });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    expect(await balanceOf(app, a)).toBe(0);
  });

  it('unknown account → 404 and nothing is written; invalid uuid → 400', async () => {
    const key = randomUUID();
    const res = await post(randomUUID(), { amount: 10 }, key);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ACCOUNT_NOT_FOUND');
    expect(await countByKey(key)).toBe(0);
    const bad = await post('not-a-uuid', { amount: 10 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION_ERROR');
  });

  it('invalid Idempotency-Key (space) → 400', async () => {
    const a = await newAccount(app);
    const res = await post(a, { amount: 10 }, 'has space');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('deposit idempotency', () => {
  it('same Idempotency-Key twice → 201 both, same id, Idempotent-Replayed: true, balance credited once', async () => {
    const a = await newAccount(app);
    const key = randomUUID();
    const first = await post(a, { amount: 100 }, key);
    const second = await post(a, { amount: 100.0 }, key);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json()).toEqual(first.json());
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(app, a)).toBe(100);
  });

  it('same key twice on an upper-case account id → 201 both, replayed, credited once, id echoed lower-case', async () => {
    const a = await newAccount(app);
    const key = randomUUID();
    const first = await post(a.toUpperCase(), { amount: 100 }, key);
    const second = await post(a.toUpperCase(), { amount: 100 }, key);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json().accountId).toBe(a);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(app, a)).toBe(100);
    const stmt = await app.inject({
      method: 'GET',
      url: `/accounts/${a.toUpperCase()}/statement`,
    });
    expect(stmt.json().accountId).toBe(a);
  });

  it('same key, different amount → 422 IDEMPOTENCY_KEY_REUSED, balance unchanged', async () => {
    const a = await newAccount(app);
    const key = randomUUID();
    await post(a, { amount: 100 }, key);
    const res = await post(a, { amount: 200 }, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(app, a)).toBe(100);
  });

  it('same key on a different account → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const key = randomUUID();
    await post(a, { amount: 100 }, key);
    const res = await post(b, { amount: 100 }, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(app, b)).toBe(0);
  });

  it('logs "deposit processed" at info with depositId, accountId, idempotencyKey and replayed', async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      pool,
      logger: { stream: { write: (l: string) => lines.push(l) } },
    });
    const a = await newAccount(logged);
    const key = randomUUID();
    const send = () =>
      logged.inject({
        method: 'POST',
        url: `/accounts/${a}/deposits`,
        headers: { 'idempotency-key': key },
        payload: { amount: 10 },
      });
    const first = await send();
    await send();
    await logged.close();
    const line = { level: 30, depositId: first.json().id, accountId: a, idempotencyKey: key };
    expect(lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'deposit processed')).toEqual([
      expect.objectContaining({ ...line, replayed: false }),
      expect.objectContaining({ ...line, replayed: true }),
    ]);
  });

  it('5 parallel deposits with the same key → one deposit, balance credited once', async () => {
    const a = await newAccount(app);
    const key = randomUUID();
    // Hold the account lock so all 5 pass the (empty) key lookup and queue on FOR UPDATE: forces the ON CONFLICT path.
    const holder = await pool.connect();
    let results: Awaited<ReturnType<typeof post>>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a]);
      const { rows } = await holder.query('SELECT pg_backend_pid() AS pid');
      const pending = Promise.all(Array.from({ length: 5 }, () => post(a, { amount: 100 }, key)));
      await waitForQueue(pool, rows[0].pid, 5);
      await holder.query('COMMIT');
      results = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); // no-op after COMMIT
      holder.release();
    }
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect(await countByKey(key)).toBe(1);
    const ledger = await pool.query('SELECT count(*) FROM ledger_entries WHERE account_id = $1', [
      a,
    ]);
    expect(Number(ledger.rows[0].count)).toBe(1);
    expect(await balanceOf(app, a)).toBe(100);
  });
});
