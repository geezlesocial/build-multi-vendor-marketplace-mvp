import { describe, expect, it } from 'vitest';
import { WalletBalanceState } from '@prisma/client';
import { buildPostingAllocations, buildStateTransitionAllocations } from './wallet-ledger.js';

describe('state-aware wallet allocations', () => {
  it('builds a balanced available-to-held transition', () => {
    const entries = buildStateTransitionAllocations({ accountId: 'account-1', currency: 'USD', fromState: WalletBalanceState.AVAILABLE, toState: WalletBalanceState.HELD, amountMinor: 15, referenceId: 'hold-1', idempotencyKey: 'hold-key-1' });
    expect(entries.map(entry => entry.deltaMinor)).toEqual([-15, 15]);
    expect(entries.map(entry => entry.state)).toEqual([WalletBalanceState.AVAILABLE, WalletBalanceState.HELD]);
    expect(entries.every(entry => entry.referenceType === 'STATE_TRANSITION')).toBe(true);
  });

  it('creates signed allocations for each economic posting', () => {
    const entries = buildPostingAllocations('tx-1', 'transfer-1', [
      { accountId: 'source', direction: 'CREDIT', amountMinor: 20, currency: 'USD' },
      { accountId: 'destination', direction: 'DEBIT', amountMinor: 20, currency: 'USD' }
    ]);
    expect(entries.map(entry => entry.deltaMinor)).toEqual([-20, 20]);
    expect(new Set(entries.map(entry => entry.idempotencyKey)).size).toBe(2);
  });

  it('rejects invalid or same-state transitions', () => {
    expect(() => buildStateTransitionAllocations({ accountId: 'account-1', currency: 'USD', fromState: WalletBalanceState.HELD, toState: WalletBalanceState.HELD, amountMinor: 1, referenceId: 'hold-2', idempotencyKey: 'hold-key-2' })).toThrow('must change state');
    expect(() => buildStateTransitionAllocations({ accountId: 'account-1', currency: 'USD', fromState: WalletBalanceState.HELD, toState: WalletBalanceState.AVAILABLE, amountMinor: 0, referenceId: 'hold-3', idempotencyKey: 'hold-key-3' })).toThrow();
  });
});
