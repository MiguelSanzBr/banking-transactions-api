export type AccountStatus = 'ACTIVE' | 'BLOCKED' | 'CLOSED';

export type Account = {
  id: string;
  holderName: string;
  document: string;
  status: AccountStatus;
  balanceCents: number;
  createdAt: Date;
};

// CPF (11 digits) or CNPJ (14), with or without punctuation. Checksum digits are not verified (out of scope).
export function normalizeDocument(raw: string): string | null {
  const digits = raw.replace(/[.\-/\s]/g, '');
  return /^(\d{11}|\d{14})$/.test(digits) ? digits : null;
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
