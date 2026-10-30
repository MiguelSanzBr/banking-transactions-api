import { AppError } from './errors.js';

export const MAX_AMOUNT_CENTS = 100_000_000_000;

// Parses the shortest decimal string JS prints for the double ("0.1", not 0.1000000000000000055...), so no float multiplication is involved.
export function toCents(value: number): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!m) return null; // negative, NaN, Infinity, exponent notation, more than 2 decimals
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export const toAmount = (cents: number): number => cents / 100;

export function parseAmount(value: number): number {
  // Range first: toCents is null for huge or negative values, which are out of range, not malformed.
  if (value > MAX_AMOUNT_CENTS / 100)
    throw new AppError(422, 'AMOUNT_LIMIT_EXCEEDED', 'amount exceeds the limit per operation');
  if (value <= 0) throw new AppError(422, 'INVALID_AMOUNT', 'amount must be greater than zero');
  const cents = toCents(value);
  if (cents === null)
    throw new AppError(400, 'VALIDATION_ERROR', 'amount must have at most 2 decimal places');
  return cents;
}
