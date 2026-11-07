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

  it.each([
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects %s ledger posting amounts', (_label, amountMinor) => {
    expect(() => assertBalancedPostings([
      { direction: 'DEBIT', amountMinor, currency: 'USD' },
      { direction: 'CREDIT', amountMinor, currency: 'USD' }
    ])).toThrow('positive integer minor units');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the supported maximum', 2_000_000_001],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects %s wallet transfer amounts', (_label, amountMinor) => {
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u2', amountMinor, currency: 'USD' }, Number.MAX_SAFE_INTEGER, enabledSettings, false)).toThrow();
  });

  it.each(['usd', 'US', 'USDD'])('rejects malformed transfer currency %s', currency => {
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u2', amountMinor: 100, currency }, 100, enabledSettings, false)).toThrow();
  });

  it('accepts a transfer at the configured positive minor-unit maximum', () => {
    expect(() => assertTransferAllowed({ senderId: 'u1', recipientId: 'u2', amountMinor: 2_000_000_000, currency: 'USD' }, 2_000_000_000, enabledSettings, false)).not.toThrow();
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
