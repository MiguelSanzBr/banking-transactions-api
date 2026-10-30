import { z } from 'zod';

// Lower-cased once here: Postgres returns uuids in lower case and treats both cases as equal, so a mixed-case id
// must not break the string comparisons behind idempotent replays or the same-account check.
export const uuid = z.uuid().toLowerCase();

// Generic key keeps `params.accountId` typed as string (a plain `string` key infers an index signature: string | undefined).
export const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: uuid } as Record<K, typeof uuid>);

// Fastify lowercases header names. z.object strips unknown keys, so other headers pass.
const key = z.string().regex(/^[\x21-\x7E]{1,255}$/);
export const idempotencyKeyHeader = z.object({ 'idempotency-key': key });
export const optionalIdempotencyKeyHeader = z.object({ 'idempotency-key': key.optional() });

// z.number() already rejects strings like "100" (400); decimals and range are checked by parseAmount.
export const amountField = z.number();

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
