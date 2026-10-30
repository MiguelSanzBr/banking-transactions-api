import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { toAmount } from '../shared/money.js';
import { errorResponses, uuidParam } from '../shared/schemas.js';
import { getStatement } from './service.js';

// z.iso.date() checks the calendar (2026-02-30 and 2026-13-01 fail), so no Date round trip is needed here.
// YYYY-MM-DD strings sort like dates, hence the plain string comparison.
const query = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to' });

// `id` and `transferId`/`depositId` are z.string() for the same reason as in accounts: z.uuid() would 500 on odd version bits.
const statementResponse = z.object({
  accountId: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['DEPOSIT', 'TRANSFER_IN', 'TRANSFER_OUT']),
      amount: z.number(),
      balanceAfter: z.number(),
      transferId: z.string().nullable(),
      depositId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export async function statement(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/accounts/:accountId/statement',
    {
      schema: {
        tags: ['statement'],
        summary: 'Account statement, filtered by period and paginated by cursor',
        params: uuidParam('accountId'),
        querystring: query,
        response: { 200: statementResponse, ...errorResponses(400, 404, 503) },
      },
    },
    async (req) => {
      const { accountId } = req.params;
      const { from, to } = req.query;
      const page = await getStatement(opts.pool, { accountId, ...req.query });
      return {
        accountId,
        from: from ?? null,
        to: to ?? null,
        items: page.items.map((i) => ({
          id: i.id,
          type: i.type,
          amount: toAmount(i.amountCents),
          balanceAfter: toAmount(i.balanceAfterCents),
          transferId: i.transferId,
          depositId: i.depositId,
          createdAt: i.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
