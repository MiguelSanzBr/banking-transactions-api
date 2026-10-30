import { randomInt } from 'node:crypto';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';

// Callers close both in afterAll: `await app.close(); await pool.end();`
export async function makeApp(opts: { lockTimeoutMs?: number } = {}) {
  const pool = createPool(inject('databaseUrl'), { max: 20, ...opts });
  const app = await buildApp({ pool });
  return { app, pool };
}

export const randomDocument = () => String(randomInt(0, 1e11)).padStart(11, '0');
