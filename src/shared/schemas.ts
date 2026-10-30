import { z } from 'zod';

// Generic key keeps `params.accountId` typed as string (a plain `string` key infers an index signature: string | undefined).
export const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: z.uuid() } as Record<K, z.ZodUUID>);

// Fastify lowercases header names. z.object strips unknown keys, so other headers pass.
const key = z.string().regex(/^[\x21-\x7E]{1,255}$/);
export const idempotencyKeyHeader = z.object({ 'idempotency-key': key });
export const optionalIdempotencyKeyHeader = z.object({ 'idempotency-key': key.optional() });

// z.number() already rejects strings like "100" (400); decimals and range are checked by parseAmount.
export const amountField = z.number();
