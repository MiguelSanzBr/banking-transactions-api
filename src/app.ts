import { randomUUID } from 'node:crypto';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import fastify, { type FastifyServerOptions, LogController } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { accounts } from './accounts/routes.js';
import { deposits } from './deposits/routes.js';
import { health } from './health.js';
import { errorHandler, notFoundHandler } from './shared/errors.js';
import { statement } from './statement/routes.js';
import { transfers } from './transfers/routes.js';

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

  // Before the routes: swagger collects each route through an onRoute hook.
  await app.register(fastifySwagger, {
    openapi: { info: { title: 'Banking Transactions API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject, // emits the registry ids (ErrorEnvelope) as components
  });
  await app.register(fastifySwaggerUI, { routePrefix: '/docs' }); // also serves /docs/json
  // One register per module.
  await app.register(health, { pool: opts.pool });
  await app.register(accounts, { pool: opts.pool });
  await app.register(deposits, { pool: opts.pool });
  await app.register(transfers, { pool: opts.pool });
  await app.register(statement, { pool: opts.pool });
  return app;
}
