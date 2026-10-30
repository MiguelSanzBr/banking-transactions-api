import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect, inject } from 'vitest';
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
