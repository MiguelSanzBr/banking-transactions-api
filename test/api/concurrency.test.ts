import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, depositTo, makeApp, newAccount, postTransfer } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const t = (sourceAccountId: string, destinationAccountId: string, amount: number) => ({
  sourceAccountId,
  destinationAccountId,
  amount,
});

describe('concurrent transfers', () => {
  it('balance 100, two parallel transfers of 80 → exactly one completes, balance 20', async () => {
    const [a, b, c] = [await newAccount(app), await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    // Warm up two pool connections so both transfers start together instead of the 2nd dialing a new one.
    await Promise.all([balanceOf(app, a), balanceOf(app, a)]);
    const [r1, r2] = await Promise.all([
      postTransfer(app, t(a, b, 80)),
      postTransfer(app, t(a, c, 80)),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 422]);
    expect([r1, r2].find((r) => r.statusCode === 422)?.json().code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(app, a)).toBe(20);
    expect((await balanceOf(app, b)) + (await balanceOf(app, c))).toBe(80);
  });

  it('balance 100, 20 parallel transfers of 10 → exactly 10 complete, balance 0, never negative', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => postTransfer(app, t(a, b, 10))),
    );
    const ok = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode === 422);
    expect([ok.length, rejected.length]).toEqual([10, 10]);
    expect(rejected.every((r) => r.json().code === 'INSUFFICIENT_BALANCE')).toBe(true);
    expect(await balanceOf(app, a)).toBe(0);
    expect(await balanceOf(app, b)).toBe(100);
  });

  it('A→B and B→A crossfire (30 each way, parallel) → all 201, no deadlock, A+B unchanged', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const each = 30;
    // Funded for the worst ordering: all of its outgoing transfers (each of 50) before any incoming one.
    await depositTo(app, a, each * 50);
    await depositTo(app, b, each * 50);
    const responses = await Promise.all(
      Array.from({ length: 2 * each }, (_, i) =>
        postTransfer(app, i % 2 ? t(a, b, 50) : t(b, a, 50)),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(2 * each).fill(201));
    expect([await balanceOf(app, a), await balanceOf(app, b)]).toEqual([each * 50, each * 50]);
  });

  it('random parallel transfers among 5 accounts keep the books balanced', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => newAccount(app)));
    for (const id of ids) await depositTo(app, id, 100);
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => {
        const from = randomInt(5);
        const to = (from + 1 + randomInt(4)) % 5; // never the same account
        return postTransfer(app, t(ids[from] as string, ids[to] as string, randomInt(1, 61)));
      }),
    );
    // Only the two business outcomes: no 500/503 from deadlocks or lock timeouts.
    for (const r of responses) {
      expect([201, 422]).toContain(r.statusCode);
      if (r.statusCode === 422) expect(r.json().code).toBe('INSUFFICIENT_BALANCE');
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.balance_cents,
              COALESCE(SUM(CASE WHEN l.type = 'TRANSFER_OUT' THEN -l.amount_cents ELSE l.amount_cents END), 0)::bigint AS ledger
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
       WHERE a.id = ANY($1) GROUP BY a.id`,
      [ids],
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.balance_cents).toBeGreaterThanOrEqual(0);
      expect(r.balance_cents).toBe(r.ledger);
    }
    expect(rows.reduce((s, r) => s + r.balance_cents, 0)).toBe(50000);
  });
});

describe('lock timeout', () => {
  it('locked hot account → 503 SERVICE_UNAVAILABLE with Retry-After; same key succeeds after release', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const key = `lock-${randomUUID()}`;
    const { app: fast, pool: p } = await makeApp({ lockTimeoutMs: 200 });
    const holder = await p.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a]);
      const started = Date.now();
      const res = await postTransfer(fast, t(a, b, 10), key);
      // Fails fast on lock_timeout (200 ms), not by waiting out the 15 s statement_timeout.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('1');
      await holder.query('ROLLBACK');
      const retry = await postTransfer(fast, t(a, b, 10), key);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(await balanceOf(app, a)).toBe(90);
    } finally {
      // Harmless after the happy path; after a failed assertion it frees the lock before the pool closes.
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await fast.close();
      await p.end();
    }
  });
});
