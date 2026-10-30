import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError, loggable } from './shared/errors.js';
import { errorResponses } from './shared/schemas.js';

const ok = z.object({ status: z.literal('ok') });

export async function health(app: FastifyInstance, opts: { pool: pg.Pool }) {
  app.get(
    '/health',
    { schema: { tags: ['ops'], summary: 'Liveness probe', response: { 200: ok } } },
    async () => ({ status: 'ok' }),
  );
  app.get(
    '/ready',
    {
      schema: {
        tags: ['ops'],
        summary: 'Readiness probe (checks the database)',
        response: { 200: ok, ...errorResponses(503) },
      },
    },
    async (req) => {
      try {
        await opts.pool.query('SELECT 1');
      } catch (err) {
        // Readiness: any failure means "not ready", whatever the cause.
        req.log.error({ err: loggable(err) }, 'readiness check failed');
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Service not ready');
      }
      return { status: 'ok' };
    },
  );
}
