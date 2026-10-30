import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { createPool, migrate, withTransaction } from '../../src/db.js';
import { AppError } from '../../src/shared/errors.js';
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

describe('health', () => {
  it('GET /health → 200 {status:"ok"}', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → 503 SERVICE_UNAVAILABLE when the database is unreachable', async () => {
    const deadPool = createPool('postgres://u:p@127.0.0.1:1/x');
    const deadApp = await buildApp({ pool: deadPool });
    const res = await deadApp.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    await deadApp.close();
    await deadPool.end();
  });
});

describe('readiness on any failure', () => {
  it('GET /ready → 503 (not 500) for errors outside the retryable list, logged without detail', async () => {
    const lines: string[] = [];
    const failing = {
      query: async () => {
        throw Object.assign(new Error('the database system is starting up'), {
          code: '57P03',
          detail: 'Key (document)=(12345678901)',
        });
      },
    } as unknown as pg.Pool;
    const readyApp = await buildApp({
      pool: failing,
      logger: { stream: { write: (l: string) => lines.push(l) } },
    });
    const res = await readyApp.inject({ method: 'GET', url: '/ready' });
    await readyApp.close();
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
    expect(lines.join('')).toContain('starting up');
    expect(lines.join('')).not.toContain('12345678901');
  });
});

describe('error envelope', () => {
  it('unknown route → 404 ROUTE_NOT_FOUND envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: 'ROUTE_NOT_FOUND',
      message: expect.any(String),
      timestamp: expect.stringMatching(/Z$/),
      correlationId: expect.any(String),
    });
  });

  describe('mapping', () => {
    let testApp: FastifyInstance;
    const pgError = (code: string) => Object.assign(new Error(`secret ${code} detail`), { code });

    beforeAll(async () => {
      testApp = await buildApp({ pool });
      testApp.post(
        '/t/validate',
        { schema: { body: z.object({ amount: z.number() }).strict() } },
        async () => ({}),
      );
      testApp.get('/t/app-error', async () => {
        throw new AppError(422, 'INSUFFICIENT_BALANCE', 'no funds', { transferId: 't1' });
      });
      testApp.get('/t/boom', async () => {
        throw new Error('select * from accounts where document = 12345678901');
      });
      testApp.get<{ Params: { code: string } }>('/t/pg/:code', async (req) => {
        throw pgError(req.params.code);
      });
    });
    afterAll(() => testApp.close());

    it('AppError → its status, code and extra fields', async () => {
      const res = await testApp.inject({ method: 'GET', url: '/t/app-error' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        message: 'no funds',
        transferId: 't1',
      });
    });

    it('schema violation → 400 VALIDATION_ERROR with details [{path, message}]', async () => {
      const res = await testApp.inject({
        method: 'POST',
        url: '/t/validate',
        payload: { amount: 'x', extra: 1 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details).toEqual(
        expect.arrayContaining([{ path: 'amount', message: expect.any(String) }]),
      );
      expect(body.details.length).toBeGreaterThanOrEqual(2);
    });

    it('malformed JSON → 400 VALIDATION_ERROR without echoing the body', async () => {
      const res = await testApp.inject({
        method: 'POST',
        url: '/t/validate',
        headers: { 'content-type': 'application/json' },
        payload: '{"document":"12345678901"',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.body).not.toContain('12345678901');
    });

    it('non-JSON content-type → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      const res = await testApp.inject({
        method: 'POST',
        url: '/t/validate',
        headers: { 'content-type': 'application/xml' },
        payload: '<a/>',
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('body over 1 MB → 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await testApp.inject({
        method: 'POST',
        url: '/t/validate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ amount: 'a'.repeat(1_100_000) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('unexpected error → 500 INTERNAL_ERROR without leaking the message', async () => {
      const res = await testApp.inject({ method: 'GET', url: '/t/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('INTERNAL_ERROR');
      expect(res.body).not.toMatch(/select|accounts|12345678901/);
    });

    it.each(['55P03', '57014', '40P01', '40001', '57P01', 'ECONNREFUSED'])(
      'error code %s → 503 SERVICE_UNAVAILABLE + Retry-After',
      async (code) => {
        const res = await testApp.inject({ method: 'GET', url: `/t/pg/${code}` });
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('1');
        expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
        expect(res.body).not.toContain('secret');
      },
    );

    it('a pool that was ended → 503 SERVICE_UNAVAILABLE', async () => {
      const ended = createPool('postgres://u:p@127.0.0.1:1/x');
      await ended.end();
      const endedApp = await buildApp({ pool: ended });
      endedApp.get('/t/query', async () => ended.query('SELECT 1'));
      const res = await endedApp.inject({ method: 'GET', url: '/t/query' });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
      await endedApp.close();
    });

    it('all pool clients busy → 503 after the connection timeout instead of hanging', async () => {
      const tiny = createPool(inject('databaseUrl'), { max: 1, connectionTimeoutMs: 200 });
      const held = await tiny.connect();
      const tinyApp = await buildApp({ pool: tiny });
      tinyApp.get('/t/query', async () => tiny.query('SELECT 1'));
      const res = await tinyApp.inject({ method: 'GET', url: '/t/query' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
      held.release();
      await tinyApp.close();
      await tiny.end();
    });

    it('5xx logs omit pg detail (it can hold the document)', async () => {
      const lines: string[] = [];
      const logged = await buildApp({
        pool,
        logger: { stream: { write: (l: string) => lines.push(l) } },
      });
      logged.get('/t/dup', async () => {
        throw Object.assign(new Error('duplicate key value violates "accounts_document_key"'), {
          code: '23505',
          detail: 'Key (document)=(12345678901) already exists.',
        });
      });
      const res = await logged.inject({ method: 'GET', url: '/t/dup' });
      await logged.close();
      expect(res.statusCode).toBe(500);
      expect(lines.join('')).toContain('accounts_document_key');
      expect(lines.join('')).not.toContain('12345678901');
    });
  });
});

describe('correlation id', () => {
  it('echoes a valid x-correlation-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'abc-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('abc-123');
  });

  it('replaces an invalid x-correlation-id with a uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'bad id\n' },
    });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('labels log lines with correlationId', async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      pool,
      logger: { stream: { write: (l: string) => lines.push(l) } },
    });
    await logged.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'log-1' },
    });
    await logged.close();
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ correlationId: 'log-1' }),
    );
  });

  it('generates one when absent and puts the same id in the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.headers['x-correlation-id']).toBe(res.json().correlationId);
  });
});

describe('database', () => {
  it('migrate is idempotent', async () => {
    await migrate(pool);
    await migrate(pool);
    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    expect(rows).toEqual([{ name: '001_init.sql' }]);
  });

  it('applies the session timeouts to every connection', async () => {
    const { rows } = await pool.query(
      "SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i",
    );
    expect(rows[0]).toEqual({ l: '5s', s: '15s', i: '30s' });
  });

  it('returns BIGINT as number', async () => {
    const { rows } = await pool.query('SELECT 42::bigint AS n');
    expect(rows[0].n).toBe(42);
  });

  it('refuses BIGINT beyond the safe integer range', async () => {
    await expect(pool.query('SELECT 9007199254740993::bigint AS n')).rejects.toThrow(
      /safe integer/,
    );
  });

  it('withTransaction commits on success and rolls back on error', async () => {
    const doc = `tx-${Date.now()}`;
    const insert = (c: pg.PoolClient) =>
      c.query(
        "INSERT INTO accounts (id, holder_name, document, status) VALUES (gen_random_uuid(), 'T', $1, 'ACTIVE')",
        [doc],
      );
    await expect(
      withTransaction(pool, async (c) => {
        await insert(c);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await pool.query('SELECT 1 FROM accounts WHERE document = $1', [doc])).rowCount).toBe(
      0,
    );
    await withTransaction(pool, insert);
    expect((await pool.query('SELECT 1 FROM accounts WHERE document = $1', [doc])).rowCount).toBe(
      1,
    );
  });
});
