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

// 55P03 lock timeout, 57014 statement timeout, 40P01 deadlock, 40001 serialization, 57P01 admin shutdown,
// 57P02 crash shutdown, 57P03 starting up, 53300 too many connections; the E* codes are Node failing to
// reach the database.
const RETRYABLE = new Set([
  '55P03',
  '57014',
  '40P01',
  '40001',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
// pg raises these without a code when the pool is closed, the connection drops (also "not queryable": the
// next query on a client whose connection already died), no client frees up in time or the server does not
// answer within query_timeout.
const POOL_FAILURE =
  /pool after calling end|Connection terminated|not queryable|timeout exceeded when trying to connect|Query read timeout/;

// pg errors carry row data in `detail`/`where` (e.g. the document of a unique violation): never log it.
export function loggable(err: unknown) {
  const { name, message, code, stack } = (err ?? {}) as Record<string, unknown>;
  return { name, message, code, stack };
}

// Every error response goes out here. A 4xx is logged at info so an operator can explain it from the
// correlationId: code, status and Idempotency-Key, never the body (it can hold the document).
function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  extra = {},
) {
  if (statusCode < 500)
    req.log.info(
      { code, statusCode, idempotencyKey: req.headers['idempotency-key'] },
      'request rejected',
    );
  if (statusCode === 503) reply.header('retry-after', '1');
  return reply
    .status(statusCode)
    .send({ code, message, timestamp: new Date().toISOString(), correlationId: req.id, ...extra });
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError)
    return sendError(req, reply, err.statusCode, err.code, err.message, err.extra);
  if (hasZodFastifySchemaValidationErrors(err)) {
    const details = err.validation.map((v) => ({
      path: v.instancePath.slice(1).replaceAll('/', '.'),
      message: v.message ?? 'invalid',
    }));
    return sendError(req, reply, 400, 'VALIDATION_ERROR', 'Invalid request', { details });
  }
  const { statusCode, code, message } = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  // Fastify's own 4xx (bad JSON, wrong content-type, body too large). Its messages can echo the body, so ours are fixed.
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    if (statusCode === 413)
      return sendError(req, reply, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    if (statusCode === 415)
      return sendError(
        req,
        reply,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json',
      );
    return sendError(req, reply, 400, 'VALIDATION_ERROR', 'Malformed request');
  }
  req.log.error({ err: loggable(err) }, 'request failed');
  // SQLSTATE class 08 is "connection exception".
  const connectionLost = String(code).startsWith('08');
  if (RETRYABLE.has(String(code)) || connectionLost || POOL_FAILURE.test(String(message)))
    return sendError(
      req,
      reply,
      503,
      'SERVICE_UNAVAILABLE',
      'Service temporarily unavailable, retry shortly',
    );
  return sendError(req, reply, 500, 'INTERNAL_ERROR', 'Internal server error');
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  return sendError(req, reply, 404, 'ROUTE_NOT_FOUND', 'Route not found');
}
