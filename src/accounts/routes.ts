import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { toAmount } from '../shared/money.js';
import { errorResponses, uuidParam } from '../shared/schemas.js';
import { type Account, normalizeDocument } from './rules.js';
import { changeStatus, createAccount, getAccount } from './service.js';

const status = z.enum(['ACTIVE', 'BLOCKED', 'CLOSED']);

const createBody = z.strictObject({
  // One refine, not .regex(): zod would export a regex as an OpenAPI `pattern` without the `u` flag, and clients would read `\p` as a literal "p".
  holderName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (s) => !/[\p{Cc}\p{Cs}\uFFFD]/u.test(s) && /\p{L}/u.test(s),
      'must contain a letter and no control or invalid characters',
    )
    .describe(
      '1 to 120 characters with at least one letter; no control characters, lone surrogates or U+FFFD',
    ),
  document: z
    .string()
    .trim()
    .transform((raw, ctx) => {
      const document = normalizeDocument(raw);
      if (document === null) {
        ctx.issues.push({
          code: 'custom',
          message: 'document must be a CPF or CNPJ: digits only or the standard mask',
          input: raw,
        });
        return z.NEVER;
      }
      return document;
    }),
});

// Declared so the serializer drops anything the handler adds by mistake. `id` is z.string(): z.uuid()
// would reject a valid Postgres uuid with non-standard version bits and turn it into a 500.
const accountResponse = z.object({
  id: z.string(),
  holderName: z.string(),
  document: z.string(),
  status,
  balance: z.number(),
  createdAt: z.string(),
});

const toAccountResponse = (a: Account) => ({
  id: a.id,
  holderName: a.holderName,
  document: a.document,
  status: a.status,
  balance: toAmount(a.balanceCents),
  createdAt: a.createdAt.toISOString(),
});

export async function accounts(app: FastifyInstance, opts: { pool: pg.Pool }) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/accounts',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Create an account',
        body: createBody,
        response: { 201: accountResponse, ...errorResponses(400, 409, 415, 503) },
      },
    },
    async (req, reply) => {
      const account = await createAccount(opts.pool, req.body);
      req.log.info({ accountId: account.id }, 'account created'); // never the document or the name
      return reply
        .status(201)
        .header('location', `/accounts/${account.id}`)
        .send(toAccountResponse(account));
    },
  );

  r.get(
    '/accounts/:accountId',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Get an account with its balance',
        params: uuidParam('accountId'),
        response: { 200: accountResponse, ...errorResponses(400, 404, 503) },
      },
    },
    async (req) => toAccountResponse(await getAccount(opts.pool, req.params.accountId)),
  );

  r.patch(
    '/accounts/:accountId/status',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Change the account status (ACTIVE, BLOCKED or CLOSED; CLOSED is terminal)',
        params: uuidParam('accountId'),
        body: z.strictObject({ status }),
        response: { 200: accountResponse, ...errorResponses(400, 404, 415, 422, 503) },
      },
    },
    async (req) => {
      const { account, from } = await changeStatus(
        opts.pool,
        req.params.accountId,
        req.body.status,
      );
      if (from !== account.status)
        req.log.info({ accountId: account.id, from, to: account.status }, 'account status changed');
      return toAccountResponse(account);
    },
  );
}
