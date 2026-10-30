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
    ['123.456.789-00', '12345678900'],
    ['12.345.678/0001-90', '12345678000190'],
    [' 123 456 789 00 ', '12345678900'],
    ['1234567890', null],
    ['1234567890a', null],
  ])('normalizeDocument(%s) = %s', (raw, out) => expect(normalizeDocument(raw)).toBe(out));
});
