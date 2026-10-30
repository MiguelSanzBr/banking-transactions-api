import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, depositTo, makeApp, newAccount, postTransfer, setStatus } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const countByKey = async (key: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM transfers WHERE idempotency_key = $1', [key]))
    .rows[0].n;

describe('POST /transfers', () => {
  it('transfer 30 of 100 → 201 COMPLETED; source 70, destination 30', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const res = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 30,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 30,
      status: 'COMPLETED',
      failureCode: null,
    });
    expect(new Date(res.json().createdAt).toISOString()).toBe(res.json().createdAt);
    expect(res.headers.location).toBe(`/transfers/${res.json().id}`);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([70, 30]);
    const ledger = await pool.query(
      `SELECT account_id, type, amount_cents, balance_after_cents FROM ledger_entries WHERE transfer_id = $1 ORDER BY id`,
      [res.json().id],
    );
    expect(ledger.rows).toEqual([
      { account_id: a, type: 'TRANSFER_OUT', amount_cents: 3000, balance_after_cents: 7000 },
      { account_id: b, type: 'TRANSFER_IN', amount_cents: 3000, balance_after_cents: 3000 },
    ]);
  });

  it('transfer of the whole balance → 201, source 0', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const res = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 100,
    });
    expect(res.statusCode).toBe(201);
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([0, 100]);
  });

  it('balance 100, transfer 150 → 422 INSUFFICIENT_BALANCE, balance stays 100, GET shows FAILED', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const res = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 150,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      transferId: expect.any(String),
      correlationId: expect.any(String),
    });
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([100, 0]);
    const t = await app.inject({ method: 'GET', url: `/transfers/${res.json().transferId}` });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({
      status: 'FAILED',
      failureCode: 'INSUFFICIENT_BALANCE',
      amount: 150,
    });
  });

  it('source BLOCKED → 422 SOURCE_ACCOUNT_NOT_ACTIVE; source CLOSED → same', async () => {
    const [blocked, closed, b] = [
      await newAccount(app),
      await newAccount(app),
      await newAccount(app),
    ];
    await depositTo(app, blocked, 100);
    await setStatus(app, blocked, 'BLOCKED');
    await setStatus(app, closed, 'CLOSED');
    for (const source of [blocked, closed]) {
      const res = await postTransfer(app, {
        sourceAccountId: source,
        destinationAccountId: b,
        amount: 50,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        code: 'SOURCE_ACCOUNT_NOT_ACTIVE',
        transferId: expect.any(String),
      });
    }
    expect([await balanceOf(app, blocked), await balanceOf(app, b)]).toEqual([100, 0]);
  });

  it('destination BLOCKED → 201 (blocked accounts receive credits)', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    await setStatus(app, b, 'BLOCKED');
    const res = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 40,
    });
    expect(res.statusCode).toBe(201);
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([60, 40]);
  });

  it('destination CLOSED → 422 DESTINATION_ACCOUNT_CLOSED', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    await setStatus(app, b, 'CLOSED');
    const res = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 40,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'DESTINATION_ACCOUNT_CLOSED',
      transferId: expect.any(String),
    });
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([100, 0]);
  });

  it('same account → 422 SAME_ACCOUNT without transferId', async () => {
    const a = await newAccount(app);
    await depositTo(app, a, 100);
    const key = randomUUID();
    // Upper-case is the same uuid to Postgres, so it must not slip past the check.
    for (const source of [a, a.toUpperCase()]) {
      const res = await postTransfer(
        app,
        { sourceAccountId: source, destinationAccountId: a, amount: 10 },
        key,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('SAME_ACCOUNT');
      expect(res.json()).not.toHaveProperty('transferId');
    }
    expect(await countByKey(key)).toBe(0);
    expect(await balanceOf(app, a)).toBe(100);
  });

  it('unknown source or destination → 404 ACCOUNT_NOT_FOUND, nothing persisted (same key works afterwards)', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const key = randomUUID();
    for (const body of [
      { sourceAccountId: randomUUID(), destinationAccountId: b, amount: 10 },
      { sourceAccountId: a, destinationAccountId: randomUUID(), amount: 10 },
    ]) {
      const res = await postTransfer(app, body, key);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ACCOUNT_NOT_FOUND');
    }
    expect(await countByKey(key)).toBe(0);
    const ok = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount: 10 },
      key,
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
  });

  it.each([
    [0, 422, 'INVALID_AMOUNT'],
    [0.001, 400, 'VALIDATION_ERROR'],
    ['30', 400, 'VALIDATION_ERROR'],
    [1e15, 422, 'AMOUNT_LIMIT_EXCEEDED'],
  ])('amount %j → %s %s', async (amount, status, code) => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const key = randomUUID();
    const res = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount },
      key,
    );
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    expect(await countByKey(key)).toBe(0);
    expect(await balanceOf(app, a)).toBe(100);
  });

  it('invalid uuid in body → 400; missing Idempotency-Key → 400; 256-char key → 400; key "abc123" is accepted', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const body = { sourceAccountId: a, destinationAccountId: b, amount: 10 };

    const badUuid = await postTransfer(app, { ...body, destinationAccountId: 'not-a-uuid' });
    expect(badUuid.statusCode).toBe(400);
    expect(badUuid.json().code).toBe('VALIDATION_ERROR');

    const noKey = await app.inject({ method: 'POST', url: '/transfers', payload: body });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().code).toBe('VALIDATION_ERROR');

    const longKey = await postTransfer(app, body, 'k'.repeat(256));
    expect(longKey.statusCode).toBe(400);
    expect(longKey.json().code).toBe('VALIDATION_ERROR');

    expect(await balanceOf(app, a)).toBe(100);
    const ok = await postTransfer(app, body, 'abc123');
    expect(ok.statusCode).toBe(201);
    expect(await balanceOf(app, a)).toBe(90);
  });

  it('COMPLETED transfer writes one TransferCompleted event; FAILED writes none', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const ok = await postTransfer(app, { sourceAccountId: a, destinationAccountId: b, amount: 30 });
    const failed = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 500,
    });
    expect([ok.statusCode, failed.statusCode]).toEqual([201, 422]);
    const eventsOf = async (id: string) =>
      (
        await pool.query(
          'SELECT id, event_type, payload, published_at FROM outbox_events WHERE aggregate_id = $1',
          [id],
        )
      ).rows;

    const events = await eventsOf(ok.json().id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'TransferCompleted', published_at: null });
    expect(events[0].payload).toEqual({
      eventId: events[0].id,
      eventType: 'TransferCompleted',
      transferId: ok.json().id,
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 30,
      occurredAt: ok.json().createdAt,
    });
    expect(await eventsOf(failed.json().transferId)).toHaveLength(0);
  });
});

describe('GET /transfers/:transferId', () => {
  it('GET /transfers/:id → 200; unknown → 404 TRANSFER_NOT_FOUND; not-a-uuid → 400', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const created = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 25,
    });
    const res = await app.inject({ method: 'GET', url: `/transfers/${created.json().id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created.json());

    const unknown = await app.inject({ method: 'GET', url: `/transfers/${randomUUID()}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('TRANSFER_NOT_FOUND');

    const bad = await app.inject({ method: 'GET', url: '/transfers/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION_ERROR');
  });
});
