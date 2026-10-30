import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { parseAmount, toAmount } from '../shared/money.js';
import {
  amountField,
  errorResponses,
  optionalIdempotencyKeyHeader,
  uuidParam,
} from '../shared/schemas.js';
import { deposit } from './service.js';

// `id` and `accountId` are z.string() for the same reason as in accounts: z.uuid() would 500 on odd version bits.
const depositResponse = z.object({
  id: z.string(),
  accountId: z.string(),
  amount: z.number(),
  createdAt: z.string(),
});

export async function deposits(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/accounts/:accountId/deposits',
    {
      schema: {
        tags: ['deposits'],
        summary: 'Deposit into an account (Idempotency-Key optional)',
        params: uuidParam('accountId'),
        headers: optionalIdempotencyKeyHeader,
        body: z.strictObject({ amount: amountField }),
        response: { 201: depositResponse, ...errorResponses(400, 404, 415, 422, 503) },
      },
    },
    async (req, reply) => {
      const result = await deposit(opts.pool, {
        accountId: req.params.accountId,
        amountCents: parseAmount(req.body.amount),
        idempotencyKey: req.headers['idempotency-key'],
      });
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      const d = result.deposit;
      return reply.status(201).send({
        id: d.id,
        accountId: d.accountId,
        amount: toAmount(d.amountCents),
        createdAt: d.createdAt.toISOString(),
      });
    },
  );
}
