import type pg from 'pg';
import { getAccount } from '../accounts/service.js';

export type StatementItem = {
  id: number;
  type: 'DEPOSIT' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountCents: number;
  balanceAfterCents: number;
  transferId: string | null;
  depositId: string | null;
  createdAt: Date;
};

const DAY_MS = 86_400_000;

// `cursor` and `nextCursor` are ledger ids: the route encodes and decodes them.
export async function getStatement(
  pool: pg.Pool,
  input: { accountId: string; from?: string; to?: string; limit: number; cursor?: number },
): Promise<{ items: StatementItem[]; nextCursor: number | null }> {
  await getAccount(pool, input.accountId); // 404 for unknown accounts; BLOCKED and CLOSED keep their statement
  // UTC instants built here, never `::date` in SQL: that cast follows the session TimeZone and would shift the day.
  const from = input.from ? new Date(`${input.from}T00:00:00Z`) : null;
  const to = input.to ? new Date(Date.parse(`${input.to}T00:00:00Z`) + DAY_MS) : null; // exclusive: start of the next day
  // Ordered by id, not created_at (see README, "Extrato"). LIMIT + 1 detects a next page.
  const { rows } = await pool.query<StatementItem>(
    `SELECT id, type, amount_cents AS "amountCents", balance_after_cents AS "balanceAfterCents",
            transfer_id AS "transferId", deposit_id AS "depositId", created_at AS "createdAt"
       FROM ledger_entries
      WHERE account_id = $1
        AND ($2::timestamptz IS NULL OR created_at >= $2)
        AND ($3::timestamptz IS NULL OR created_at < $3)
        AND ($4::bigint IS NULL OR id > $4)
      ORDER BY id
      LIMIT $5 + 1`,
    [input.accountId, from, to, input.cursor ?? null, input.limit],
  );
  const items = rows.slice(0, input.limit);
  const last = items[items.length - 1] as StatementItem; // limit >= 1, so a non-empty page whenever rows overflow
  return { items, nextCursor: rows.length > input.limit ? last.id : null };
}
