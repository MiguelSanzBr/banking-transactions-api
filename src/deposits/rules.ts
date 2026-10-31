import { type AccountStatus, canCredit } from '../accounts/rules.js';

export type DepositFailureCode = 'ACCOUNT_CLOSED';

// BLOCKED accounts still receive deposits; only CLOSED refuses them.
export function checkDeposit(status: AccountStatus): DepositFailureCode | null {
  return canCredit(status) ? null : 'ACCOUNT_CLOSED';
}
