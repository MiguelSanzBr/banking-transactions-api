import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db.js';
import { AppError } from '../shared/errors.js';
import { type Account, type AccountStatus, checkStatusChange } from './rules.js';

const COLUMNS = `id, holder_name AS "holderName", document, status, balance_cents AS "balanceCents", created_at AS "createdAt"`;

const notFound = () => new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');

export async function createAccount(
  pool: pg.Pool,
  input: { holderName: string; document: string },
): Promise<Account> {
  try {
    // One INSERT, still in a transaction: every write goes through withTransaction.
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<Account>(
        `INSERT INTO accounts (id, holder_name, document, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING ${COLUMNS}`,
        [randomUUID(), input.holderName, input.document],
      );
      return rows[0] as Account; // RETURNING always yields the inserted row
    });
  } catch (err) {
    // The UNIQUE index is the arbiter: it also settles parallel creates with the same document.
    if ((err as { code?: string }).code === '23505')
      throw new AppError(
        409,
        'DOCUMENT_ALREADY_EXISTS',
        'An account with this document already exists',
      );
    throw err;
  }
}

// A read: no transaction needed.
export async function getAccount(pool: pg.Pool, id: string): Promise<Account> {
  const { rows } = await pool.query<Account>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

const REJECTION_MESSAGE = {
  ACCOUNT_CLOSED: 'Account is closed',
  ACCOUNT_HAS_BALANCE: 'Account still has a balance',
};

// `from` is the status before the call, for the route's log line.
export function changeStatus(
  pool: pg.Pool,
  id: string,
  status: AccountStatus,
): Promise<{ account: Account; from: AccountStatus }> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<Account>(
      `SELECT ${COLUMNS} FROM accounts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const account = rows[0];
    if (!account) throw notFound();
    const rejection = checkStatusChange(account.status, status, account.balanceCents);
    if (rejection) throw new AppError(422, rejection, REJECTION_MESSAGE[rejection]);
    if (account.status === status) return { account, from: status };
    const updated = await c.query<Account>(
      `UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    return { account: updated.rows[0] as Account, from: account.status };
  });
}
