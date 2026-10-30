import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { AppError, loggable } from './shared/errors.js';

export async function health(app: FastifyInstance, opts: { pool: pg.Pool }) {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (req) => {
    try {
      await opts.pool.query('SELECT 1');
    } catch (err) {
      // Readiness: any failure means "not ready", whatever the cause.
      req.log.error({ err: loggable(err) }, 'readiness check failed');
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Service not ready');
    }
    return { status: 'ok' };
  });
}
