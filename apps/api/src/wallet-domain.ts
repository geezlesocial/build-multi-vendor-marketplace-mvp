import { z } from 'zod';

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Currency must be an uppercase ISO-style code');
export const positiveMinorSchema = z.number().int().positive().max(2_000_000_000);

export type Posting = {
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
};

export function assertBalancedPostings(postings: Posting[]) {
  if (postings.length < 2) throw new Error('A ledger transaction requires at least two postings');
  const currencies = new Set(postings.map(posting => posting.currency));
  if (currencies.size !== 1) throw new Error('All ledger postings must use one currency');
  if (!currencyCodeSchema.safeParse(postings[0]?.currency).success) throw new Error('Ledger currency is invalid');
  for (const posting of postings) {
    if (posting.direction !== 'DEBIT' && posting.direction !== 'CREDIT') throw new Error('Ledger posting direction is invalid');
    if (!Number.isSafeInteger(posting.amountMinor) || posting.amountMinor <= 0) throw new Error('Ledger amounts must be positive integer minor units');
  }
  const debit = postings.filter(posting => posting.direction === 'DEBIT').reduce((sum, posting) => sum + BigInt(posting.amountMinor), 0n);
  const credit = postings.filter(posting => posting.direction === 'CREDIT').reduce((sum, posting) => sum + BigInt(posting.amountMinor), 0n);
  if (debit !== credit || debit === 0n) throw new Error('Ledger postings must be balanced and non-zero');
  return { currency: postings[0]!.currency, amountMinor: debit };
}

export type WalletGateSettings = {
  walletEnabled: boolean;
  walletFundingEnabled: boolean;
  walletTransfersEnabled: boolean;
  walletCheckoutEnabled: boolean;
  walletWithdrawalsEnabled: boolean;
  walletEmergencyPause: boolean;
};

export function isWalletActionEnabled(action: keyof Pick<WalletGateSettings, 'walletFundingEnabled' | 'walletTransfersEnabled' | 'walletCheckoutEnabled' | 'walletWithdrawalsEnabled'>, settings: WalletGateSettings, hardDisabled: boolean) {
  return !hardDisabled && settings.walletEnabled && !settings.walletEmergencyPause && settings[action];
}

export function assertTransferAllowed(input: { senderId: string; recipientId: string; amountMinor: number; currency: string }, availableMinor: number, settings: WalletGateSettings, hardDisabled: boolean) {
  if (!isWalletActionEnabled('walletTransfersEnabled', settings, hardDisabled)) throw new Error('Wallet transfers are disabled');
  if (input.senderId === input.recipientId) throw new Error('Self-transfer is not allowed');
  positiveMinorSchema.parse(input.amountMinor);
  currencyCodeSchema.parse(input.currency);
  if (!Number.isSafeInteger(availableMinor) || availableMinor < input.amountMinor) throw new Error('Insufficient available wallet funds');
}

export function assertCoinEntry(input: { amount: number; balance: number; allowNegative: boolean }) {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) throw new Error('Club Coin entry must be a non-zero integer');
  if (!input.allowNegative && input.amount < 0) throw new Error('Negative Club Coin entries require an approved reversal or redemption');
  if (input.balance + input.amount < 0) throw new Error('Club Coin balance cannot become negative');
}

export function publicWalletStatus(status: string) {
  return status.toLowerCase().replaceAll('_', ' ');
}
