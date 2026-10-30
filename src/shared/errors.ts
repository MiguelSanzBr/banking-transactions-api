import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'ROUTE_NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'TRANSFER_NOT_FOUND'
  | 'DOCUMENT_ALREADY_EXISTS'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_LIMIT_EXCEEDED'
  | 'SAME_ACCOUNT'
  | 'SOURCE_ACCOUNT_NOT_ACTIVE'
  | 'DESTINATION_ACCOUNT_CLOSED'
  | 'INSUFFICIENT_BALANCE'
  | 'ACCOUNT_CLOSED'
  | 'ACCOUNT_HAS_BALANCE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// 55P03 lock timeout, 57014 statement timeout, 40P01 deadlock, 40001 serialization, 57P01 admin shutdown.
const RETRYABLE = new Set([
  '55P03',
  '57014',
  '40P01',
  '40001',
  '57P01',
  'ECONNREFUSED',
  'ECONNRESET',
]);
// pg raises these without a code when the pool is closed, the connection drops or no client frees up in time.
const POOL_FAILURE =
  /pool after calling end|Connection terminated|timeout exceeded when trying to connect/;

// pg errors carry row data in `detail`/`where` (e.g. the document of a unique violation): never log it.
export function loggable(err: unknown) {
  const { name, message, code, stack } = (err ?? {}) as Record<string, unknown>;
  return { name, message, code, stack };
}

function envelope(req: FastifyRequest, code: ErrorCode, message: string, extra = {}) {
  return { code, message, timestamp: new Date().toISOString(), correlationId: req.id, ...extra };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    if (err.statusCode === 503) reply.header('retry-after', '1');
    return reply.status(err.statusCode).send(envelope(req, err.code, err.message, err.extra));
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const details = err.validation.map((v) => ({
      path: v.instancePath.slice(1).replaceAll('/', '.'),
      message: v.message ?? 'invalid',
    }));
    return reply
      .status(400)
      .send(envelope(req, 'VALIDATION_ERROR', 'Invalid request', { details }));
  }
  const { statusCode, code, message } = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  // Fastify's own 4xx (bad JSON, wrong content-type, body too large). Its messages can echo the body, so ours are fixed.
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    if (statusCode === 413)
      return reply.status(413).send(envelope(req, 'PAYLOAD_TOO_LARGE', 'Request body too large'));
    if (statusCode === 415)
      return reply
        .status(415)
        .send(envelope(req, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return reply.status(400).send(envelope(req, 'VALIDATION_ERROR', 'Malformed request'));
  }
  req.log.error({ err: loggable(err) }, 'request failed');
  if (RETRYABLE.has(String(code)) || POOL_FAILURE.test(String(message))) {
    return reply
      .status(503)
      .header('retry-after', '1')
      .send(envelope(req, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable, retry shortly'));
  }
  return reply.status(500).send(envelope(req, 'INTERNAL_ERROR', 'Internal server error'));
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send(envelope(req, 'ROUTE_NOT_FOUND', 'Route not found'));
}
