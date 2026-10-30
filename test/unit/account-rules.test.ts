import { describe, expect, it } from 'vitest';
import {
  type AccountStatus,
  checkStatusChange,
  normalizeDocument,
} from '../../src/accounts/rules.js';

describe('checkStatusChange', () => {
  it.each<[AccountStatus, AccountStatus, number, ReturnType<typeof checkStatusChange>]>([
    ['ACTIVE', 'BLOCKED', 0, null],
    ['BLOCKED', 'ACTIVE', 0, null],
    ['ACTIVE', 'ACTIVE', 0, null],
    ['CLOSED', 'CLOSED', 0, null],
    ['ACTIVE', 'CLOSED', 0, null],
    ['ACTIVE', 'CLOSED', 1, 'ACCOUNT_HAS_BALANCE'],
    ['CLOSED', 'ACTIVE', 0, 'ACCOUNT_CLOSED'],
    ['CLOSED', 'BLOCKED', 0, 'ACCOUNT_CLOSED'],
  ])('%s → %s (balance %s) = %s', (c, t, b, r) => expect(checkStatusChange(c, t, b)).toBe(r));
});

describe('normalizeDocument', () => {
  it.each([
    ['12345678900', '12345678900'],
    ['12345678000190', '12345678000190'],
    ['123.456.789-00', '12345678900'],
    ['12.345.678/0001-90', '12345678000190'],
  ])('normalizeDocument(%s) = %s', (raw, out) => expect(normalizeDocument(raw)).toBe(out));

  it.each([
    '1234567890',
    '1234567890a',
    '1.2.3.4-5678900', // separators in the wrong places
    '---12345678900---',
    '979/924/67-963',
    '123.456.789/00', // CPF digits with a CNPJ separator
    '12.345.678/0001-9', // one digit short
    '123.456.789-0000', // CPF mask on 14 digits
    '12345678/000190', // half a CNPJ mask
    ' 123.456.789-00',
    '123 456 789 00',
    '١٢٣٤٥٦٧٨٩٠٠', // non-ASCII digits
  ])('normalizeDocument(%j) = null', (raw) => expect(normalizeDocument(raw)).toBeNull());
});
