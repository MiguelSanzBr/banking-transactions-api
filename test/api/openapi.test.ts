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

describe('OpenAPI docs', () => {
  it('GET /docs/json exposes OpenAPI 3 with every route', async () => {
    const doc = (await app.inject({ url: '/docs/json' })).json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/accounts',
        '/accounts/{accountId}',
        '/accounts/{accountId}/status',
        '/accounts/{accountId}/deposits',
        '/accounts/{accountId}/statement',
        '/transfers',
        '/transfers/{transferId}',
      ]),
    );
  });

  it('every operation has tags and a summary, and every error response is a $ref to the one ErrorEnvelope', async () => {
    type Operation = {
      tags?: string[];
      summary?: string;
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    const doc = (await app.inject({ url: '/docs/json' })).json();
    const operations = Object.values<Record<string, Operation>>(doc.paths).flatMap((path) =>
      Object.values(path),
    );
    expect(operations.length).toBeGreaterThanOrEqual(9);
    let errorCount = 0;
    for (const op of operations) {
      expect(op.tags?.length).toBeGreaterThan(0);
      expect(op.summary).toBeTruthy();
      for (const [status, response] of Object.entries(op.responses)) {
        if (Number(status) < 400) continue;
        errorCount++;
        expect(response.content?.['application/json']?.schema).toEqual({
          $ref: '#/components/schemas/ErrorEnvelope',
        });
      }
    }
    expect(errorCount).toBeGreaterThan(0);
    expect(Object.keys(doc.components.schemas.ErrorEnvelope.properties)).toEqual(
      expect.arrayContaining([
        'code',
        'message',
        'timestamp',
        'correlationId',
        'details',
        'transferId',
      ]),
    );
  });

  it('GET /docs/ serves the Swagger UI page', async () => {
    const res = await app.inject({ url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});
