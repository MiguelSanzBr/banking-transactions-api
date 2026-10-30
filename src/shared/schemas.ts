import { z } from 'zod';

// Lower-cased once here: Postgres returns uuids in lower case and treats both cases as equal, so a mixed-case id
// must not break the string comparisons behind idempotent replays or the same-account check.
export const uuid = z.uuid().toLowerCase();

// Generic key keeps `params.accountId` typed as string (a plain `string` key infers an index signature: string | undefined).
export const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: uuid } as Record<K, typeof uuid>);

// Fastify lowercases header names. z.object strips unknown keys, so other headers pass.
const KEY_MESSAGE = 'Idempotency-Key must be 1 to 255 visible ASCII characters (no spaces)';
export const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;
const key = z.string(KEY_MESSAGE).regex(IDEMPOTENCY_KEY, KEY_MESSAGE);
export const idempotencyKeyHeader = z.object({ 'idempotency-key': key });
export const optionalIdempotencyKeyHeader = z.object({ 'idempotency-key': key.optional() });

// z.number() already rejects strings like "100" (400); decimals and range are checked by parseAmount (no multipleOf: float semantics).
export const amountField = z.number().meta({
  description:
    'Amount in reais (BRL): greater than 0, at most 2 decimal places, at most 1000000000.00',
  example: 250.5,
});

// The one error body every non-2xx response uses (built in shared/errors.ts). The registry id makes each route's
// error response a $ref to a single components schema instead of a copy.
export const errorEnvelope = z
  .object({
    code: z.string(),
    message: z.string(),
    timestamp: z.string(),
    correlationId: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    transferId: z.string().optional(),
  })
  .meta({ id: 'ErrorEnvelope' });

// errorResponses(400, 404) is { 400: errorEnvelope, 404: errorEnvelope }; the literal keys keep each route's reply type exact.
export const errorResponses = <C extends number>(...codes: C[]) =>
  Object.fromEntries(codes.map((c) => [c, errorEnvelope])) as Record<C, typeof errorEnvelope>;
