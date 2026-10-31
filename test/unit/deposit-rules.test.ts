import { describe, expect, it } from 'vitest';
import type { AccountStatus } from '../../src/accounts/rules.js';
import { checkDeposit, type DepositFailureCode } from '../../src/deposits/rules.js';

describe('checkDeposit', () => {
  it.each<[AccountStatus, DepositFailureCode | null]>([
    ['ACTIVE', null],
    ['BLOCKED', null],
    ['CLOSED', 'ACCOUNT_CLOSED'],
  ])('checkDeposit → %s = %s', (status, expected) => expect(checkDeposit(status)).toBe(expected));
});
