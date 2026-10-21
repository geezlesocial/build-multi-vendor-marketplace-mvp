import { describe, expect, it } from 'vitest';
import { assertBalancedPostings, assertCoinEntry, assertTransferAllowed, isWalletActionEnabled } from './wallet-domain.js';

const enabledSettings = { walletEnabled: true, walletFundingEnabled: true, walletTransfersEnabled: true, walletCheckoutEnabled: true, walletWithdrawalsEnabled: true, walletEmergencyPause: false };

describe('wallet and Club Coins safety rules', () => {
  it('accepts balanced same-currency double-entry postings', () => {
    expect(assertBalancedPostings([{ direction: 'CREDIT', amountMinor: 1250, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 1250, currency: 'USD' }])).toEqual({ currency: 'USD', amountMinor: 1250n });
  });

  it('rejects unbalanced, mixed-currency, zero, and fractional postings', () => {
    expect(() => assertBalancedPostings([{ direction: 'CREDIT', amountMinor: 100, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 99, currency: 'USD' }])).toThrow('balanced');
    expect(() => assertBalancedPostings([{ direction: 'CREDIT', amountMinor: 100, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 100, currency: 'PHP' }])).toThrow('one currency');
    expect(() => assertBalancedPostings([{ direction: 'CREDIT', amountMinor: 0, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 0, currency: 'USD' }])).toThrow('positive');
    expect(() => assertBalancedPostings([{ direction: 'CREDIT', amountMinor: 10.5, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 10.5, currency: 'USD' }])).toThrow('positive');
    expect(() => assertBalancedPostings([{ direction: 'OTHER' as never, amountMinor: 100, currency: 'USD' }, { direction: 'DEBIT', amountMinor: 100, currency: 'USD' }])).toThrow('direction');
  });

  it('keeps all real-money actions disabled behind the hard gate', () => {
    expect(isWalletActionEnabled('walletTransfersEnabled', enabledSettings, true)).toBe(false);
    expect(isWalletActionEnabled('walletTransfersEnabled', { ...enabledSettings, walletEmergencyPause: true }, false)).toBe(false);
    expect(isWalletActionEnabled('walletTransfersEnabled', enabledSettings, false)).toBe(true);
  });

  it('rejects self-transfer and overspending', () => {
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u1', amountMinor: 100, currency: 'USD' }, 100, enabledSettings, false)).toThrow('Self-transfer');
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u2', amountMinor: 101, currency: 'USD' }, 100, enabledSettings, false)).toThrow('Insufficient');
  });

  it('rejects transfers while disabled', () => {
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u2', amountMinor: 100, currency: 'USD' }, 100, { ...enabledSettings, walletTransfersEnabled: false }, false)).toThrow('disabled');
  });

  it('prevents Club Coin balances from becoming negative', () => {
    expect(() => assertCoinEntry({ amount: -101, balance: 100, allowNegative: true })).toThrow('negative');
    expect(assertCoinEntry({ amount: 50, balance: 100, allowNegative: false })).toBeUndefined();
  });

  it('requires negative Club Coin entries to be explicitly allowed', () => {
    expect(() => assertCoinEntry({ amount: -10, balance: 100, allowNegative: false })).toThrow('reversal');
  });
});
