import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { parseAmount, toAmount } from '../shared/money.js';
import { amountField, errorResponses, idempotencyKeyHeader, uuidParam } from '../shared/schemas.js';
import type { TransferFailureCode } from './rules.js';
import { createTransfer, getTransfer, type Transfer } from './service.js';

// Lower-cased because Postgres treats upper/lower-case uuids as equal; the same-account and replay checks compare strings.
const accountId = z.uuid().toLowerCase();

// Ids are z.string() for the same reason as in accounts: z.uuid() would 500 on odd version bits.
const transferResponse = z.object({
  id: z.string(),
  sourceAccountId: z.string(),
  destinationAccountId: z.string(),
  amount: z.number(),
  status: z.enum(['COMPLETED', 'FAILED']),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
});

const toTransferResponse = (t: Transfer) => ({
  id: t.id,
  sourceAccountId: t.sourceAccountId,
  destinationAccountId: t.destinationAccountId,
  amount: toAmount(t.amountCents),
  status: t.status,
  failureCode: t.failureCode,
  createdAt: t.createdAt.toISOString(),
});

const FAILURE_MESSAGE: Record<TransferFailureCode, string> = {
  SOURCE_ACCOUNT_NOT_ACTIVE: 'Source account is not active',
  DESTINATION_ACCOUNT_CLOSED: 'Destination account is closed',
  INSUFFICIENT_BALANCE: 'Insufficient balance',
};

export async function transfers(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/transfers',
    {
      schema: {
        tags: ['transfers'],
        summary: 'Transfer between accounts (Idempotency-Key required)',
        headers: idempotencyKeyHeader,
        body: z.strictObject({
          sourceAccountId: accountId,
          destinationAccountId: accountId,
          amount: amountField,
        }),
        response: { 201: transferResponse, ...errorResponses(400, 404, 415, 422, 503) },
      },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const { transfer: t, replayed } = await createTransfer(opts.pool, {
        sourceAccountId: req.body.sourceAccountId,
        destinationAccountId: req.body.destinationAccountId,
        amountCents: parseAmount(req.body.amount),
        idempotencyKey,
      });
      req.log.info(
        {
          transferId: t.id,
          idempotencyKey,
          status: t.status,
          failureCode: t.failureCode,
          replayed,
        },
        'transfer processed',
      );
      // Set before a FAILED throw too: the error handler keeps custom headers.
      if (replayed) reply.header('idempotent-replayed', 'true');
      if (t.failureCode)
        throw new AppError(422, t.failureCode, FAILURE_MESSAGE[t.failureCode], {
          transferId: t.id,
        });
      return reply.status(201).header('location', `/transfers/${t.id}`).send(toTransferResponse(t));
    },
  );

  r.get(
    '/transfers/:transferId',
    {
      schema: {
        tags: ['transfers'],
        summary: 'Get a transfer',
        params: uuidParam('transferId'),
        response: { 200: transferResponse, ...errorResponses(400, 404, 503) },
      },
    },
    async (req) => toTransferResponse(await getTransfer(opts.pool, req.params.transferId)),
  );
}
