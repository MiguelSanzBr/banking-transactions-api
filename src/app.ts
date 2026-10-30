import { randomUUID } from 'node:crypto';
import fastify, { type FastifyServerOptions, LogController } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { accounts } from './accounts/routes.js';
import { health } from './health.js';
import { errorHandler, notFoundHandler } from './shared/errors.js';

const CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function buildApp(opts: { pool: pg.Pool; logger?: FastifyServerOptions['logger'] }) {
  const app = fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && CORRELATION_ID.test(h) ? h : randomUUID();
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.removeContentTypeParser('text/plain'); // on by default; removed so non-JSON bodies get 415, not 400
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  // One register per module; later tasks add theirs here.
  await app.register(health, { pool: opts.pool });
  await app.register(accounts, { pool: opts.pool });
  return app;
}
