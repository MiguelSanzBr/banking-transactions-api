import { type AccountStatus, canCredit, canDebit } from '../accounts/rules.js';

export type TransferFailureCode =
  | 'SOURCE_ACCOUNT_NOT_ACTIVE'
  | 'DESTINATION_ACCOUNT_CLOSED'
  | 'INSUFFICIENT_BALANCE';

// Order matters: an inactive source is reported even when it also lacks balance. BLOCKED destinations receive credits.
export function checkTransfer(
  source: { status: AccountStatus; balanceCents: number },
  destination: { status: AccountStatus },
  amountCents: number,
): TransferFailureCode | null {
  if (!canDebit(source.status)) return 'SOURCE_ACCOUNT_NOT_ACTIVE';
  if (!canCredit(destination.status)) return 'DESTINATION_ACCOUNT_CLOSED';
  if (source.balanceCents < amountCents) return 'INSUFFICIENT_BALANCE';
  return null;
}
