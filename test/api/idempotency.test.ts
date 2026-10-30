import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

// Keys are unique per test: all test files share one database and the key is globally unique.
const newKey = () => `abc-${randomUUID()}`;

// Two accounts, the first one funded with `balance`.
async function funded(balance: number) {
  const [a, b] = [await newAccount(app), await newAccount(app)];
  if (balance > 0) await depositTo(app, a, balance);
  return { a, b };
}

const countByKey = async (key: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM transfers WHERE idempotency_key = $1', [key]))
    .rows[0].n;

describe('transfer idempotency', () => {
  it('retry with the same key → same transfer, Idempotent-Replayed: true, debited once', async () => {
    const { a, b } = await funded(100);
    const key = newKey();
    const body = { sourceAccountId: a, destinationAccountId: b, amount: 100 };
    const first = await postTransfer(app, body, key);
    const second = await postTransfer(app, body, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(app, a)).toBe(0);
    expect(await balanceOf(app, b)).toBe(100);
    expect(await countByKey(key)).toBe(1);
  });

  it('250 and 250.00 with fields reordered are the same request', async () => {
    const { a, b } = await funded(1000);
    const key = newKey();
    const r1 = await postTransfer(
      app,
      `{"sourceAccountId":"${a}","destinationAccountId":"${b}","amount":250}`,
      key,
    );
    const r2 = await postTransfer(
      app,
      `{"amount":250.00,"destinationAccountId":"${b}","sourceAccountId":"${a}"}`,
      key,
    );
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().id).toBe(r1.json().id);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(app, a)).toBe(750);
  });

  it('same key, different amount → 422 IDEMPOTENCY_KEY_REUSED, balances unchanged', async () => {
    const { a, b } = await funded(100);
    const key = newKey();
    const first = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount: 30 },
      key,
    );
    expect(first.statusCode).toBe(201);
    const reused = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount: 40 },
      key,
    );
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([70, 30]);
    expect(await countByKey(key)).toBe(1);
  });

  it('same key, different destination → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { a, b } = await funded(100);
    const c = await newAccount(app);
    const key = newKey();
    const first = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount: 30 },
      key,
    );
    expect(first.statusCode).toBe(201);
    const reused = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: c, amount: 30 },
      key,
    );
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect([await balanceOf(app, a), await balanceOf(app, b), await balanceOf(app, c)]).toEqual([
      70, 30, 0,
    ]);
  });

  it('same key, different source → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { a, b } = await funded(100);
    const c = await newAccount(app);
    await depositTo(app, c, 100);
    const key = newKey();
    const first = await postTransfer(
      app,
      { sourceAccountId: a, destinationAccountId: b, amount: 30 },
      key,
    );
    expect(first.statusCode).toBe(201);
    const reused = await postTransfer(
      app,
      { sourceAccountId: c, destinationAccountId: b, amount: 30 },
      key,
    );
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect([await balanceOf(app, a), await balanceOf(app, b), await balanceOf(app, c)]).toEqual([
      70, 30, 100,
    ]);
  });

  it('replay of a FAILED transfer stays FAILED even after the account is funded', async () => {
    const { a, b } = await funded(0);
    const key = newKey();
    const body = { sourceAccountId: a, destinationAccountId: b, amount: 50 };
    const first = await postTransfer(app, body, key);
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      transferId: expect.any(String),
    });
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    await depositTo(app, a, 100);
    const retry = await postTransfer(app, body, key);
    expect(retry.statusCode).toBe(422);
    expect(retry.json()).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      transferId: first.json().transferId,
    });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(app, a)).toBe(100);
    expect(await balanceOf(app, b)).toBe(0);
    expect(await countByKey(key)).toBe(1);
  });

  it('replay after the source got BLOCKED returns the original 201', async () => {
    const { a, b } = await funded(100);
    const key = newKey();
    const body = { sourceAccountId: a, destinationAccountId: b, amount: 30 };
    const first = await postTransfer(app, body, key);
    expect(first.statusCode).toBe(201);

    await setStatus(app, a, 'BLOCKED');
    const retry = await postTransfer(app, body, key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([70, 30]);
  });

  it('10 parallel requests with the same key → all 201 with the same id, one row, debited once', async () => {
    const amount = 30;
    const { a, b } = await funded(100);
    const key = newKey();
    const body = { sourceAccountId: a, destinationAccountId: b, amount };

    // Hold both account locks, queue the 10 requests behind them, then release: every request has
    // already missed the key lookup, so the race is guaranteed instead of depending on timing.
    const holder = await pool.connect();
    let res: Awaited<ReturnType<typeof postTransfer>>[];
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [[a, b]],
      );
      const { rows } = await holder.query('SELECT pg_backend_pid() AS pid');
      const pending = Promise.all(Array.from({ length: 10 }, () => postTransfer(app, body, key)));
      await vi.waitFor(
        async () => {
          // Postgres queues row-lock waiters behind each other, so follow the chain back to the holder.
          const blocked = await pool.query(
            `WITH RECURSIVE waiting(pid) AS (
               SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
               UNION
               SELECT s.pid FROM pg_stat_activity s JOIN waiting w ON w.pid = ANY(pg_blocking_pids(s.pid))
             ) SELECT count(*)::int AS n FROM waiting`,
            [rows[0].pid],
          );
          expect(blocked.rows[0].n).toBe(10);
        },
        { timeout: 3000, interval: 20 },
      );
      await holder.query('COMMIT');
      res = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); // no-op after COMMIT
      holder.release();
    }

    expect(new Set(res.map((r) => r.statusCode))).toEqual(new Set([201]));
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    // Exactly one request executed; the other nine are replays.
    expect(res.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect(await countByKey(key)).toBe(1);
    expect(await balanceOf(app, a)).toBe(100 - amount);
    expect(await balanceOf(app, b)).toBe(amount);
    const events = await pool.query('SELECT 1 FROM outbox_events WHERE aggregate_id = $1', [
      res[0]?.json().id,
    ]);
    expect(events.rowCount).toBe(1);
  });
});
