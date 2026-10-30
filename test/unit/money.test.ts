import { describe, expect, it } from 'vitest';
import { parseAmount, toAmount, toCents } from '../../src/shared/money.js';

describe('toCents', () => {
  it.each([
    [500, 50000],
    [0.1, 10],
    [0.29, 29],
    [1500.5, 150050],
    [100.01, 10001],
    [999999999.99, 99999999999],
  ])('toCents(%s) = %s', (v, c) => expect(toCents(v)).toBe(c));

  it.each([100.001, 0.1 + 0.2, 1e-7, 1e21, Number.NaN, Number.POSITIVE_INFINITY])(
    'toCents(%s) = null',
    (v) => expect(toCents(v)).toBeNull(),
  );

  it('keeps sign; -0 is 0', () => {
    expect(toCents(-5)).toBe(-500);
    expect(toCents(-0)).toBe(0);
  });
});

describe('toAmount', () => {
  it('round-trips', () => {
    expect(toAmount(150050)).toBe(1500.5);
    expect(toAmount(10)).toBe(0.1);
  });
});

describe('parseAmount', () => {
  it('>2 decimals → 400', () =>
    expect(() => parseAmount(10.005)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR' }),
    ));

  it.each([0, -1])('parseAmount(%s) → 422 INVALID_AMOUNT', (v) =>
    expect(() => parseAmount(v)).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'INVALID_AMOUNT' }),
    ),
  );

  it('above max → 422 AMOUNT_LIMIT_EXCEEDED', () =>
    expect(() => parseAmount(1_000_000_000.01)).toThrow(
      expect.objectContaining({ statusCode: 422, code: 'AMOUNT_LIMIT_EXCEEDED' }),
    ));

  it.each([1e15, 1e21, Number.POSITIVE_INFINITY])(
    'parseAmount(%s) → 422 AMOUNT_LIMIT_EXCEEDED even when toCents is null',
    (v) =>
      expect(() => parseAmount(v)).toThrow(
        expect.objectContaining({ statusCode: 422, code: 'AMOUNT_LIMIT_EXCEEDED' }),
      ),
  );

  it('parseAmount(1e-7) → 400 VALIDATION_ERROR', () =>
    expect(() => parseAmount(1e-7)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR' }),
    ));

  it('at max is ok', () => expect(parseAmount(1_000_000_000)).toBe(100_000_000_000));
});
