import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AccountStatus } from '../accounts/rules.js';
import { withTransaction } from '../db.js';
import { AppError } from '../shared/errors.js';
import { toAmount } from '../shared/money.js';
import { checkTransfer, type TransferFailureCode } from './rules.js';

export type Transfer = {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountCents: number;
  status: 'COMPLETED' | 'FAILED';
  failureCode: TransferFailureCode | null;
  createdAt: Date;
};

const COLUMNS = `id, source_account_id AS "sourceAccountId", destination_account_id AS "destinationAccountId",
  amount_cents AS "amountCents", status, failure_code AS "failureCode", created_at AS "createdAt"`;

export function createTransfer(
  pool: pg.Pool,
  input: {
    sourceAccountId: string;
    destinationAccountId: string;
    amountCents: number;
    idempotencyKey: string;
  },
): Promise<{ transfer: Transfer; replayed: boolean }> {
  const { sourceAccountId, destinationAccountId, amountCents, idempotencyKey } = input;
  // Checked before the database: nothing is written and the key is not consumed.
  if (sourceAccountId === destinationAccountId)
    throw new AppError(422, 'SAME_ACCOUNT', 'Source and destination accounts must differ');

  return withTransaction(pool, async (c) => {
    // Equivalence is on the normalized fields, never the raw body.
    const findByKey = async () => {
      const { rows } = await c.query<Transfer>(
        `SELECT ${COLUMNS} FROM transfers WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const existing = rows[0];
      if (!existing) return null;
      if (
        existing.sourceAccountId !== sourceAccountId ||
        existing.destinationAccountId !== destinationAccountId ||
        existing.amountCents !== amountCents
      )
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different payload',
        );
      return { transfer: existing, replayed: true };
    };

    const replay = await findByKey();
    if (replay) return replay;

    // Fixed lock order (by id) so A→B and B→A running together cannot deadlock.
    const { rows: accounts } = await c.query<{
      id: string;
      status: AccountStatus;
      balanceCents: number;
    }>(
      `SELECT id, status, balance_cents AS "balanceCents" FROM accounts
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[sourceAccountId, destinationAccountId]],
    );
    const source = accounts.find((a) => a.id === sourceAccountId);
    const destination = accounts.find((a) => a.id === destinationAccountId);
    if (!source || !destination) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');

    // A business rejection is persisted as FAILED: it consumes the key, so a retry gets the same answer.
    const failureCode = checkTransfer(source, destination, amountCents);
    const inserted = await c.query<Transfer>(
      `INSERT INTO transfers (id, idempotency_key, source_account_id, destination_account_id, amount_cents, status, failure_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        idempotencyKey,
        sourceAccountId,
        destinationAccountId,
        amountCents,
        failureCode ? 'FAILED' : 'COMPLETED',
        failureCode,
      ],
    );
    const transfer = inserted.rows[0];
    if (!transfer) {
      // No row: a concurrent request with the same key committed first, so answer from it.
      const winner = await findByKey();
      if (!winner) throw new Error('transfer insert conflicted but no row has its idempotency key');
      return winner;
    }
    if (failureCode) return { transfer, replayed: false };

    const move = (id: string, delta: number) =>
      c.query<{ balance: number }>(
        'UPDATE accounts SET balance_cents = balance_cents + $2, updated_at = now() WHERE id = $1 RETURNING balance_cents AS balance',
        [id, delta],
      );
    const debited = await move(sourceAccountId, -amountCents);
    const credited = await move(destinationAccountId, amountCents);
    await c.query(
      `INSERT INTO ledger_entries (account_id, type, amount_cents, balance_after_cents, transfer_id)
       VALUES ($1, 'TRANSFER_OUT', $3, $4, $6), ($2, 'TRANSFER_IN', $3, $5, $6)`,
      [
        sourceAccountId,
        destinationAccountId,
        amountCents,
        debited.rows[0]?.balance,
        credited.rows[0]?.balance,
        transfer.id,
      ],
    );
    // Same transaction as the balance change: the event exists if and only if the money moved.
    const eventId = randomUUID();
    await c.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'TransferCompleted', $2, $3)`,
      [
        eventId,
        transfer.id,
        {
          eventId,
          eventType: 'TransferCompleted',
          transferId: transfer.id,
          sourceAccountId,
          destinationAccountId,
          amount: toAmount(amountCents),
          occurredAt: transfer.createdAt.toISOString(),
        },
      ],
    );
    return { transfer, replayed: false };
  });
}

// Single statement: no transaction needed.
export async function getTransfer(pool: pg.Pool, id: string): Promise<Transfer> {
  const { rows } = await pool.query<Transfer>(`SELECT ${COLUMNS} FROM transfers WHERE id = $1`, [
    id,
  ]);
  if (!rows[0]) throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
  return rows[0];
}
