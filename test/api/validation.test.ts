import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  ({ app, pool } = await makeApp());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('Idempotency-Key validation message', () => {
  const MESSAGE = 'Idempotency-Key must be 1 to 255 visible ASCII characters (no spaces)';
  const transfer = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/transfers',
      headers,
      payload: { sourceAccountId: randomUUID(), destinationAccountId: randomUUID(), amount: 1 },
    });

  it.each([
    ['with a space', 'a b'],
    ['of 256 characters', 'x'.repeat(256)],
    ['non-ASCII', 'chave-ação'],
  ])('key %s → 400 with a human message, not the regex', async (_label, key) => {
    const res = await transfer({ 'idempotency-key': key });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ path: 'idempotency-key', message: MESSAGE }]);
  });

  it('missing key on /transfers → 400 with the same message', async () => {
    const res = await transfer({});
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ path: 'idempotency-key', message: MESSAGE }]);
  });

  it('optional key on a deposit: invalid → 400 with the message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${randomUUID()}/deposits`,
      headers: { 'idempotency-key': 'a b' },
      payload: { amount: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ path: 'idempotency-key', message: MESSAGE }]);
  });
});

describe('OpenAPI amount', () => {
  it.each(['/accounts/{accountId}/deposits', '/transfers'])(
    '%s documents the amount unit, limits and an example (no multipleOf: float semantics)',
    async (path) => {
      const doc = (await app.inject({ url: '/docs/json' })).json();
      const amount =
        doc.paths[path].post.requestBody.content['application/json'].schema.properties.amount;
      expect(amount).toMatchObject({
        type: 'number',
        description: expect.stringMatching(
          /reais.*greater than 0.*2 decimal places.*1000000000\.00/,
        ),
        example: 250.5,
      });
      expect(amount).not.toHaveProperty('multipleOf');
    },
  );
});

describe('OpenAPI holderName', () => {
  // zod drops the regex `u` flag when it emits a pattern, so a client compiling `\p{L}` would read a literal "p".
  it('has no pattern (the rules are described, not exported as a regex)', async () => {
    const doc = (await app.inject({ url: '/docs/json' })).json();
    const name =
      doc.paths['/accounts'].post.requestBody.content['application/json'].schema.properties
        .holderName;
    expect(name).toMatchObject({ type: 'string', minLength: 1, maxLength: 120 });
    expect(JSON.stringify(name)).not.toContain('pattern');
  });
});
