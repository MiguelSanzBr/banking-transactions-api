import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createPool, withTransaction } from '../src/db.js';
import { depositTo, makeApp, newAccount, postTransfer } from './helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

// Polls until a backend is waiting on a lock held by `holderPid`.
async function blockedBy(holderPid: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
      [holderPid],
    );
    if (rows[0]) return rows[0].pid;
    await sleep(20);
  }
  throw new Error('no backend waited on the lock');
}

describe('dropped connection', () => {
  it('a backend killed mid-transaction → 503, and the process and pool keep working', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a]);
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = postTransfer(app, {
        sourceAccountId: a,
        destinationAccountId: b,
        amount: 10,
      });
      const waiting = await blockedBy(holderPid);
      await holder.query('SELECT pg_terminate_backend($1)', [waiting]);
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // Let the socket close reach the client: without a listener its 'error' event kills the process here.
    await sleep(100);
    const retry = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 10,
    });
    expect(retry.statusCode).toBe(201);
  });

  it('an error on an idle client (e.g. a database restart) is logged, not thrown, and the pool recovers', async () => {
    const idle = createPool(inject('databaseUrl'), { max: 1 });
    const client = await idle.connect();
    client.release(); // idle now: pg-pool forwards its errors to the pool's 'error' event
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Without a pool 'error' listener this emit throws, as an uncaught exception would in production.
      expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
      expect(logged).toHaveBeenCalledWith('idle pg client error:', 'terminating connection');
    } finally {
      logged.mockRestore();
    }
    expect((await idle.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    await idle.end();
  });
});

describe('withTransaction', () => {
  it('runs at READ COMMITTED even when the session default is stricter', async () => {
    const strict = createPool(inject('databaseUrl'), { max: 1 }); // one client: the SET and the transaction share a session
    await strict.query("SET default_transaction_isolation = 'repeatable read'");
    const level = await withTransaction(
      strict,
      async (c) => (await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
    );
    await strict.end();
    expect(level).toBe('read committed');
  });
});

describe('timeouts', () => {
  it('idle_in_transaction_session_timeout comes from the options', async () => {
    const custom = createPool(inject('databaseUrl'), { idleInTxTimeoutMs: 45000 });
    const { rows } = await custom.query(
      "SELECT current_setting('idle_in_transaction_session_timeout') AS i",
    );
    await custom.end();
    expect(rows[0].i).toBe('45s');
  });

  it('a transaction on a server that stops answering gives up after query_timeout + 1 s and never leaks', async () => {
    const tiny = createPool(inject('databaseUrl'), { max: 1, queryTimeoutMs: 2000 });
    const document = `leak-${randomUUID()}`;
    // pg_sleep outlives the query timeout and the ROLLBACK's own 1 s, so the ROLLBACK is never sent.
    const started = Date.now();
    await expect(
      withTransaction(tiny, async (c) => {
        await c.query(
          "INSERT INTO accounts (id, holder_name, document, status) VALUES (gen_random_uuid(), 'T', $1, 'ACTIVE')",
          [document],
        );
        await c.query('SELECT pg_sleep(4)');
      }),
    ).rejects.toThrow('Query read timeout');
    // ~3 s; a ROLLBACK waiting a full query_timeout would take ~4 s.
    expect(Date.now() - started).toBeLessThan(3500);
    // A reused connection would run this inside the open transaction and commit the INSERT.
    await withTransaction(tiny, (c) => c.query('SELECT 1'));
    await tiny.end();
    const { rowCount } = await pool.query('SELECT 1 FROM accounts WHERE document = $1', [document]);
    expect(rowCount).toBe(0);
  });
});
