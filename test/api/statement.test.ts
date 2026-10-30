import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { depositTo, makeApp, newAccount, postTransfer, setStatus } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const statement = (accountId: string, query = '') =>
  app.inject({ method: 'GET', url: `/accounts/${accountId}/statement${query}` });

const transfer = async (from: string, to: string, amount: number) =>
  expect(
    (await postTransfer(app, { sourceAccountId: from, destinationAccountId: to, amount }))
      .statusCode,
  ).toBe(201);

// Ledger ids of an account in insertion order, as the strings the API returns. Selected as numbers so ORDER BY is numeric.
const ledgerIds = async (accountId: string) =>
  (
    await pool.query('SELECT id FROM ledger_entries WHERE account_id = $1 ORDER BY id', [accountId])
  ).rows.map((r) => String(r.id));

const backdate = (id: string, at: string) =>
  pool.query('UPDATE ledger_entries SET created_at = $2 WHERE id = $1', [id, at]);

describe('GET /accounts/:accountId/statement', () => {
  it('lists DEPOSIT, TRANSFER_OUT, TRANSFER_IN in order with balanceAfter', async () => {
    const [a, b, c] = [await newAccount(app), await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 500);
    await depositTo(app, c, 200);
    await transfer(a, b, 100);
    await transfer(c, a, 75);
    const res = await statement(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      accountId: a,
      from: null,
      to: null,
      nextCursor: null,
      items: [
        {
          type: 'DEPOSIT',
          amount: 500,
          balanceAfter: 500,
          depositId: expect.any(String),
          transferId: null,
        },
        {
          type: 'TRANSFER_OUT',
          amount: 100,
          balanceAfter: 400,
          transferId: expect.any(String),
          depositId: null,
        },
        {
          type: 'TRANSFER_IN',
          amount: 75,
          balanceAfter: 475,
          transferId: expect.any(String),
          depositId: null,
        },
      ],
    });
    const { items } = res.json();
    expect(items).toHaveLength(3);
    expect(items.map((i: { id: string }) => i.id)).toEqual(await ledgerIds(a));
    for (const i of items) expect(new Date(i.createdAt).toISOString()).toBe(i.createdAt);
  });

  it('a deposit and a transfer have the same createdAt in their response and statement entries, even after a lock wait', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 100);
    // Hold a's lock so both requests begin well before they can move money: the contention case.
    const holder = await pool.connect();
    let dep: Awaited<ReturnType<typeof postTransfer>>;
    let tr: Awaited<ReturnType<typeof postTransfer>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a]);
      const pending = Promise.all([
        app.inject({ method: 'POST', url: `/accounts/${a}/deposits`, payload: { amount: 10 } }),
        postTransfer(app, { sourceAccountId: a, destinationAccountId: b, amount: 30 }),
      ]);
      await setTimeout(50);
      await holder.query('COMMIT');
      [dep, tr] = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); // no-op after COMMIT
      holder.release();
    }
    expect([dep.statusCode, tr.statusCode]).toEqual([201, 201]);
    const entries = [...(await statement(a)).json().items, ...(await statement(b)).json().items];
    const createdAtOf = (field: 'depositId' | 'transferId', id: string) =>
      entries.filter((i) => i[field] === id).map((i) => i.createdAt);
    expect(createdAtOf('depositId', dep.json().id)).toEqual([dep.json().createdAt]);
    expect(createdAtOf('transferId', tr.json().id)).toEqual([
      tr.json().createdAt,
      tr.json().createdAt,
    ]);
    // Exact in SQL too, not only at the API's millisecond precision.
    const { rows } = await pool.query(
      `SELECT l.created_at = coalesce(t.created_at, d.created_at) AS same
         FROM ledger_entries l
         LEFT JOIN transfers t ON t.id = l.transfer_id
         LEFT JOIN deposits d ON d.id = l.deposit_id
        WHERE l.transfer_id = $1 OR l.deposit_id = $2`,
      [tr.json().id, dep.json().id],
    );
    expect(rows.map((r) => r.same)).toEqual([true, true, true]);
  });

  it('FAILED transfers do not appear', async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 50);
    const failed = await postTransfer(app, {
      sourceAccountId: a,
      destinationAccountId: b,
      amount: 100,
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().transferId).toEqual(expect.any(String));
    const res = await statement(a);
    expect(res.json().items.map((i: { type: string }) => i.type)).toEqual(['DEPOSIT']);
    expect((await statement(b)).json().items).toEqual([]);
  });

  it('to is inclusive of the whole day in UTC', async () => {
    const a = await newAccount(app);
    for (let i = 0; i < 3; i++) await depositTo(app, a, 1);
    const [e1, e2, e3] = await ledgerIds(a);
    await backdate(e1 as string, '2026-09-10T23:59:59.999Z');
    await backdate(e2 as string, '2026-09-11T00:00:00Z');
    await backdate(e3 as string, '2026-08-31T23:59:59Z');
    const res = await statement(a, '?from=2026-09-01&to=2026-09-10');
    expect(res.json()).toMatchObject({ from: '2026-09-01', to: '2026-09-10' });
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([e1]);
  });

  it('from is inclusive at 00:00:00Z and open-ended without to', async () => {
    const a = await newAccount(app);
    for (let i = 0; i < 2; i++) await depositTo(app, a, 1);
    const [e1, e2] = await ledgerIds(a);
    await backdate(e1 as string, '2026-09-01T00:00:00Z');
    await backdate(e2 as string, '2026-08-31T23:59:59.999Z');
    const ids = async (query: string) =>
      (await statement(a, query)).json().items.map((i: { id: string }) => i.id);
    expect(await ids('?from=2026-09-01')).toEqual([e1]);
    expect(await ids('?to=2026-08-31')).toEqual([e2]);
  });

  it.each([
    'from=2026-09-30&to=2026-09-01',
    'from=2026-02-30',
    'from=2026-02-29', // 2026 is not a leap year
    'from=2026-13-01',
    'from=2026-9-1',
    'to=yesterday',
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=abc',
    'limit=1e1', // plain digits only: Number() would read these as 10, 16, 5 and 3
    'limit=0x10',
    'limit=%205',
    'limit=%2B3',
    'cursor=@@',
    'cursor=',
    `cursor=${Buffer.from('abc').toString('base64url')}`,
    `cursor=${Buffer.from('-5').toString('base64url')}`, // digits only: no negative ids
    `cursor=${Buffer.from('9'.repeat(20)).toString('base64url')}`, // would overflow bigint
  ])('?%s → 400 VALIDATION_ERROR', async (query) => {
    const a = await newAccount(app);
    const res = await statement(a, `?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('an invalid cursor is a schema error that names the field', async () => {
    const res = await statement(await newAccount(app), '?cursor=@@');
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([expect.objectContaining({ path: 'cursor' })]);
  });

  it('invalid account id → 400 VALIDATION_ERROR', async () => {
    const res = await statement('not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('limit defaults to 50 and accepts 100', async () => {
    const a = await newAccount(app);
    for (let i = 0; i < 51; i++) await depositTo(app, a, 1);
    const page = (await statement(a)).json();
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    const max = await statement(a, '?limit=100');
    expect(max.statusCode).toBe(200);
    expect(max.json().items).toHaveLength(51);
    expect(max.json().nextCursor).toBeNull();
  });

  it('paginates 5 entries with limit=2 → 2, 2, 1, no duplicates, last nextCursor null', async () => {
    const a = await newAccount(app);
    for (let i = 0; i < 5; i++) await depositTo(app, a, 1);
    const all = await ledgerIds(a);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await statement(a, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const page: { items: { id: string }[]; nextCursor: string | null } = res.json();
      sizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(all);
    // Exactly `limit` entries left: no phantom next page.
    const exact = await statement(a, '?limit=5');
    expect(exact.json().items).toHaveLength(5);
    expect(exact.json().nextCursor).toBeNull();
  });

  it('orders and paginates by the numeric id across a digit-count change', async () => {
    const a = await newAccount(app);
    await depositTo(app, a, 1);
    const [n] = await ledgerIds(a);
    const [{ id: depositId }] = (
      await pool.query('SELECT deposit_id AS id FROM ledger_entries WHERE account_id = $1', [a])
    ).rows;
    // Two extra rows with explicit ids of 12 and 13 digits (random, so a rerun on the same DB never collides).
    // Sorted as text the 13-digit id would come first: "1..." < "9...".
    const rand = () => Math.floor(Math.random() * 1e11);
    const [twelve, thirteen] = [String(9e11 + rand()), String(1e12 + rand())];
    for (const id of [twelve, thirteen])
      await pool.query(
        `INSERT INTO ledger_entries (id, account_id, type, amount_cents, balance_after_cents, deposit_id)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'DEPOSIT', 1, 1, $3)`,
        [id, a, depositId],
      );
    const expected = [n, twelve, thirteen];
    expect([...expected].sort()).not.toEqual(expected); // the premise: text order differs from numeric order
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await statement(a, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((i: { id: string }) => i.id));
      cursor = res.json().nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);
  });

  it('accepts 29 February of a leap year as a one-day period', async () => {
    const a = await newAccount(app);
    await depositTo(app, a, 1);
    const [e1] = await ledgerIds(a);
    await backdate(e1 as string, '2024-02-29T12:00:00Z');
    const res = await statement(a, '?from=2024-02-29&to=2024-02-29');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([e1]);
  });

  it('unknown account → 404; BLOCKED and CLOSED accounts still have a statement', async () => {
    const missing = await statement(randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('ACCOUNT_NOT_FOUND');

    const [a, b] = [await newAccount(app), await newAccount(app)];
    await depositTo(app, a, 10);
    await setStatus(app, a, 'BLOCKED');
    expect((await statement(a)).json().items).toHaveLength(1);

    await setStatus(app, a, 'ACTIVE');
    await transfer(a, b, 10); // empties a so it can be closed
    await setStatus(app, a, 'CLOSED');
    const closed = await statement(a);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().items.map((i: { type: string }) => i.type)).toEqual([
      'DEPOSIT',
      'TRANSFER_OUT',
    ]);
  });
});
