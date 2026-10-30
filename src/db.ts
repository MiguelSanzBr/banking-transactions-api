import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export function createPool(
  databaseUrl: string,
  opts: {
    max?: number;
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
    connectionTimeoutMs?: number;
  } = {},
): pg.Pool {
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
    statement_timeout: opts.statementTimeoutMs ?? 15000,
    idle_in_transaction_session_timeout: 30000,
  });
  // Without a listener an error on an idle client (e.g. database restart) crashes the process.
  pool.on('error', (err) => console.error('idle pg client error:', err.message));
  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {}); // the original error matters more than a failed rollback
    throw err;
  } finally {
    c.release();
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
