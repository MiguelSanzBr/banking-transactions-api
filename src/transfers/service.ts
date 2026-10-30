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
    correlationId: string;
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
    if (!failureCode) await moveMoney(c, transfer, input.correlationId);
    return { transfer, replayed: false };
  });
}

// A COMPLETED transfer's writes, run while createTransfer holds both account locks.
async function moveMoney(c: pg.PoolClient, t: Transfer, correlationId: string): Promise<void> {
  const { id, sourceAccountId, destinationAccountId, amountCents, createdAt } = t;
  const move = async (accountId: string, delta: number) => {
    const { rows } = await c.query<{ balance: number }>(
      'UPDATE accounts SET balance_cents = balance_cents + $2, updated_at = now() WHERE id = $1 RETURNING balance_cents AS balance',
      [accountId, delta],
    );
    return rows[0]?.balance;
  };
  const debited = await move(sourceAccountId, -amountCents);
  const credited = await move(destinationAccountId, amountCents);

  // One row per side, values in column order. The transfer's own timestamp, so the response, the event and the
  // statement show the same instant. One statement, not two: every round trip here is spent holding the locks.
  const debit = [sourceAccountId, 'TRANSFER_OUT', amountCents, debited, id, createdAt];
  const credit = [destinationAccountId, 'TRANSFER_IN', amountCents, credited, id, createdAt];
  await c.query(
    `INSERT INTO ledger_entries (account_id, type, amount_cents, balance_after_cents, transfer_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
    [...debit, ...credit],
  );

  // Same transaction as the balance change: the event exists if and only if the money moved.
  const eventId = randomUUID();
  await c.query(
    `INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'TransferCompleted', $2, $3)`,
    [
      eventId,
      id,
      {
        eventId,
        eventType: 'TransferCompleted',
        transferId: id,
        sourceAccountId,
        destinationAccountId,
        amount: toAmount(amountCents),
        occurredAt: createdAt.toISOString(),
        correlationId, // lets a consumer trace the event back to the request
      },
    ],
  );
}

// Single statement: no transaction needed.
export async function getTransfer(pool: pg.Pool, id: string): Promise<Transfer> {
  const { rows } = await pool.query<Transfer>(`SELECT ${COLUMNS} FROM transfers WHERE id = $1`, [
    id,
  ]);
  if (!rows[0]) throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
  return rows[0];
}
