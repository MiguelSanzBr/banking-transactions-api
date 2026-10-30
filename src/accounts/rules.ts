export type AccountStatus = 'ACTIVE' | 'BLOCKED' | 'CLOSED';

export type Account = {
  id: string;
  holderName: string;
  document: string;
  status: AccountStatus;
  balanceCents: number;
  createdAt: Date;
};

// CPF or CNPJ: raw digits or the canonical mask only, so "1.2.3.4-5678900" is rejected. Checksum digits are not verified (out of scope).
const DOCUMENT = /^(\d{11}|\d{14}|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})$/;
export function normalizeDocument(raw: string): string | null {
  return DOCUMENT.test(raw) ? raw.replace(/\D/g, '') : null;
}

// Same status is a no-op (checked first, so CLOSED → CLOSED stays 200); CLOSED is terminal.
export function checkStatusChange(
  current: AccountStatus,
  target: AccountStatus,
  balanceCents: number,
): 'ACCOUNT_CLOSED' | 'ACCOUNT_HAS_BALANCE' | null {
  if (current === target) return null;
  if (current === 'CLOSED') return 'ACCOUNT_CLOSED';
  if (target === 'CLOSED' && balanceCents > 0) return 'ACCOUNT_HAS_BALANCE';
  return null;
}
