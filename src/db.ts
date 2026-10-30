import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export function createPool(
  databaseUrl: string,
  opts: {
    max?: number;
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
    idleInTxTimeoutMs?: number;
    connectionTimeoutMs?: number;
    queryTimeoutMs?: number;
  } = {},
): pg.Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? 15000;
  // BIGINT (balances, ledger ids) must stay a JS number; refuse values that would lose precision.
  pg.types.setTypeParser(20, (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new RangeError('BIGINT outside the safe integer range');
    return n;
  });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    // Bounded wait for a free client: pg's default (0) queues forever when every client is busy.
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
    lock_timeout: opts.lockTimeoutMs ?? 5000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: opts.idleInTxTimeoutMs ?? 30000,
    // Server-side timeouts cannot fire when the server never answers (frozen host, no TCP reset).
    query_timeout: opts.queryTimeoutMs ?? statementTimeoutMs + 5000,
    // TCP keepalive probes start after 10 s of silence (OS default: 2 h), so a peer that vanished
    // without a reset is noticed on a connection waiting for an answer.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
  // Without a listener an error on an idle client (e.g. database restart) crashes the process.
  pool.on('error', (err) => console.error('idle pg client error:', err.message));
  // pg-pool drops its listener while a client is checked out; the in-flight query already rejects, this only prevents the crash.
  pool.on('connect', (client) => client.on('error', () => {}));
  return pool;
}

// pg honours a per-query query_timeout (missing from @types/pg). ROLLBACK is instant on a live server; its own
// 1 s keeps a frozen one from costing a second full query_timeout.
const ROLLBACK = { text: 'ROLLBACK', query_timeout: 1000 };

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    // The original error is the one to report. But after a failed ROLLBACK (e.g. query_timeout) the transaction
    // may still be open on the server: release(broken) makes the pool destroy the connection, never reuse it.
    await c.query(ROLLBACK).catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    c.release(broken);
  }
}

// Each file runs in its own transaction, serialized across instances by an advisory lock.
export async function migrate(
  pool: pg.Pool,
  dir: URL = new URL('../migrations/', import.meta.url),
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    await withTransaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727274)');
      await c.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rowCount } = await c.query(
        'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [name],
      );
      if (rowCount) await c.query(sql);
    });
  }
}
