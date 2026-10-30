import type pg from 'pg';
import { getAccount } from '../accounts/service.js';
import { AppError } from '../shared/errors.js';

export type StatementItem = {
  id: string;
  type: 'DEPOSIT' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountCents: number;
  balanceAfterCents: number;
  transferId: string | null;
  depositId: string | null;
  createdAt: Date;
};

const DAY_MS = 86_400_000;

const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');

// Buffer decoding is lenient ("@@" decodes to nothing), so the re-encode check rejects anything we did not issue.
// At most 18 digits keeps the value inside bigint, so a forged cursor is a 400, never a Postgres 22003.
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString();
  if (!/^\d{1,18}$/.test(id) || encodeCursor(id) !== cursor)
    throw new AppError(400, 'VALIDATION_ERROR', 'cursor is invalid');
  return id;
}

export async function getStatement(
  pool: pg.Pool,
  input: { accountId: string; from?: string; to?: string; limit: number; cursor?: string },
): Promise<{ items: StatementItem[]; nextCursor: string | null }> {
  const cursorId = input.cursor === undefined ? null : decodeCursor(input.cursor);
  await getAccount(pool, input.accountId); // 404 for unknown accounts; BLOCKED and CLOSED keep their statement
  // UTC instants built here, never `::date` in SQL: that cast follows the session TimeZone and would shift the day.
  const from = input.from ? new Date(`${input.from}T00:00:00Z`) : null;
  const to = input.to ? new Date(Date.parse(`${input.to}T00:00:00Z`) + DAY_MS) : null; // exclusive: start of the next day
  // Ordered by id, not created_at (see the constraints). `ledger_entries.id` is qualified on purpose: a bare `id`
  // in ORDER BY resolves to the `id::text` output column and would sort "100" before "99". LIMIT + 1 detects a next page.
  const { rows } = await pool.query<StatementItem>(
    `SELECT id::text AS id, type, amount_cents AS "amountCents", balance_after_cents AS "balanceAfterCents",
            transfer_id AS "transferId", deposit_id AS "depositId", created_at AS "createdAt"
       FROM ledger_entries
      WHERE account_id = $1
        AND ($2::timestamptz IS NULL OR created_at >= $2)
        AND ($3::timestamptz IS NULL OR created_at < $3)
        AND ($4::bigint IS NULL OR id > $4)
      ORDER BY ledger_entries.id
      LIMIT $5 + 1`,
    [input.accountId, from, to, cursorId, input.limit],
  );
  const items = rows.slice(0, input.limit);
  const last = items[items.length - 1] as StatementItem; // limit >= 1, so a non-empty page whenever rows overflow
  return { items, nextCursor: rows.length > input.limit ? encodeCursor(last.id) : null };
}
