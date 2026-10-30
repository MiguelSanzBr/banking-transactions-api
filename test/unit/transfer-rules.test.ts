import { describe, expect, it } from 'vitest';
import type { AccountStatus } from '../../src/accounts/rules.js';
import { checkTransfer, type TransferFailureCode } from '../../src/transfers/rules.js';

describe('checkTransfer', () => {
  it.each<
    [
      { status: AccountStatus; balanceCents: number },
      { status: AccountStatus },
      number,
      TransferFailureCode | null,
    ]
  >([
    [{ status: 'ACTIVE', balanceCents: 100 }, { status: 'ACTIVE' }, 100, null],
    [{ status: 'ACTIVE', balanceCents: 100 }, { status: 'BLOCKED' }, 50, null],
    [{ status: 'ACTIVE', balanceCents: 100 }, { status: 'ACTIVE' }, 101, 'INSUFFICIENT_BALANCE'],
    [{ status: 'BLOCKED', balanceCents: 0 }, { status: 'ACTIVE' }, 50, 'SOURCE_ACCOUNT_NOT_ACTIVE'],
    [{ status: 'CLOSED', balanceCents: 0 }, { status: 'ACTIVE' }, 50, 'SOURCE_ACCOUNT_NOT_ACTIVE'],
    [
      { status: 'ACTIVE', balanceCents: 100 },
      { status: 'CLOSED' },
      50,
      'DESTINATION_ACCOUNT_CLOSED',
    ],
  ])('checkTransfer → %s, %s, %s = %s', (source, destination, amountCents, expected) =>
    expect(checkTransfer(source, destination, amountCents)).toBe(expected),
  );
});
