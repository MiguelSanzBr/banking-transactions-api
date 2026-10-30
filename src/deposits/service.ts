import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../shared/errors.js';

export type Deposit = { id: string; accountId: string; amountCents: number; createdAt: Date };

const COLUMNS = `id, account_id AS "accountId", amount_cents AS "amountCents", created_at AS "createdAt"`;

export function deposit(
  pool: pg.Pool,
  input: { accountId: string; amountCents: number; idempotencyKey?: string },
): Promise<{ deposit: Deposit; replayed: boolean }> {
  const { accountId, amountCents, idempotencyKey } = input;
  return withTransaction(pool, async (c) => {
    // Equivalence is on the normalized fields, never the raw body.
    const findByKey = async () => {
      const { rows } = await c.query<Deposit>(
        `SELECT ${COLUMNS} FROM deposits WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const existing = rows[0];
      if (!existing) return null;
      if (existing.accountId !== accountId || existing.amountCents !== amountCents)
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different payload',
        );
      return { deposit: existing, replayed: true };
    };

    if (idempotencyKey) {
      const replay = await findByKey();
      if (replay) return replay;
    }

    // Lock before inserting: a missing account is a 404 with nothing written, not an FK violation.
    const acc = await c.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    if (!acc.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    if (acc.rows[0].status === 'CLOSED')
      throw new AppError(422, 'ACCOUNT_CLOSED', 'Account is closed');

    const inserted = await c.query<Deposit>(
      `INSERT INTO deposits (id, account_id, amount_cents, idempotency_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
      [randomUUID(), accountId, amountCents, idempotencyKey ?? null],
    );
    // No row: a concurrent request with the same key committed first, so answer from it.
    if (!inserted.rows[0]) {
      const winner = await findByKey();
      if (!winner) throw new Error('deposit insert conflicted but no row has its idempotency key');
      return winner;
    }

    const updated = await c.query<{ balance: number }>(
      `UPDATE accounts SET balance_cents = balance_cents + $2, updated_at = now() WHERE id = $1 RETURNING balance_cents AS balance`,
      [accountId, amountCents],
    );
    await c.query(
      `INSERT INTO ledger_entries (account_id, type, amount_cents, balance_after_cents, deposit_id) VALUES ($1, 'DEPOSIT', $2, $3, $4)`,
      [accountId, amountCents, updated.rows[0]?.balance, inserted.rows[0].id],
    );
    return { deposit: inserted.rows[0], replayed: false };
  });
}
