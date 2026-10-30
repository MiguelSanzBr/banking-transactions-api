import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { expect, inject, vi } from 'vitest';
import type { AccountStatus } from '../src/accounts/rules.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// Callers close both in afterAll: `await app.close(); await pool.end();`
export async function makeApp(opts: { lockTimeoutMs?: number } = {}) {
  const pool = createPool(inject('databaseUrl'), { max: 20, ...opts });
  const app = await buildApp({ pool });
  return { app, pool };
}

export const randomDocument = () => String(randomInt(0, 1e11)).padStart(11, '0');

export async function newAccount(
  app: FastifyInstance,
  holderName = 'Test Holder',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/accounts',
    payload: { holderName, document: randomDocument() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

export async function setStatus(app: FastifyInstance, id: string, status: AccountStatus) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/accounts/${id}/status`,
    payload: { status },
  });
  expect(res.statusCode).toBe(200);
}

// Balance in reais, as the API returns it.
export async function balanceOf(app: FastifyInstance, id: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: `/accounts/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json().balance;
}

export async function depositTo(app: FastifyInstance, accountId: string, amount: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/accounts/${accountId}/deposits`,
    payload: { amount },
  });
  expect(res.statusCode).toBe(201);
}

// A string body is sent as-is (raw JSON), so tests can control formatting and field order.
export const postTransfer = (
  app: FastifyInstance,
  body: object | string,
  key: string = randomUUID(),
) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    payload: body,
  });

// Resolves once `n` backends wait on the locks `holderPid` holds. Postgres queues row-lock waiters behind
// each other, so the chain is followed back to the holder.
export async function waitForQueue(pool: pg.Pool, holderPid: number, n: number) {
  await vi.waitFor(
    async () => {
      const { rows } = await pool.query(
        `WITH RECURSIVE waiting(pid) AS (
           SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
           UNION
           SELECT s.pid FROM pg_stat_activity s JOIN waiting w ON w.pid = ANY(pg_blocking_pids(s.pid))
         ) SELECT count(*)::int AS n FROM waiting`,
        [holderPid],
      );
      expect(rows[0].n).toBe(n);
    },
    { timeout: 3000, interval: 20 },
  );
}
