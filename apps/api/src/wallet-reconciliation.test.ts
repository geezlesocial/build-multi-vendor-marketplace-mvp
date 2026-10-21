import { describe, expect, it } from 'vitest';
import { buildWalletReconciliationReport } from './wallet-reconciliation.js';

const balance = (overrides: Partial<Parameters<typeof buildWalletReconciliationReport>[0][number]> = {}) => ({
  accountId: 'account-1', userId: 'user-1', currency: 'USD', availableMinor: 100, pendingMinor: 0, heldMinor: 0, frozenMinor: 0, ...overrides
});

const allocation = (overrides: Partial<NonNullable<Parameters<typeof buildWalletReconciliationReport>[2]>[number]> = {}) => ({
  accountId: 'account-1', currency: 'USD', state: 'AVAILABLE' as const, deltaMinor: 100, isOpeningBaseline: false, baselineVerified: false, transactionId: 'tx-1', ...overrides
});

describe('wallet reconciliation', () => {
  it('matches an available snapshot to its posting and allocation', () => {
    const report = buildWalletReconciliationReport(
      [balance()],
      [{ accountId: 'account-1', currency: 'USD', direction: 'DEBIT', amountMinor: 100 }],
      [allocation()]
    );
    expect(report.status).toBe('MATCHED');
    expect(report.rows.find(row => row.state === 'AVAILABLE')?.discrepancy.AVAILABLE).toBeNull();
  });

  it('reports an available-balance mismatch without proposing a write', () => {
    const report = buildWalletReconciliationReport(
      [balance({ availableMinor: 101 })],
      [{ accountId: 'account-1', currency: 'USD', direction: 'DEBIT', amountMinor: 100 }],
      [allocation()]
    );
    expect(report.status).toBe('DISCREPANCY');
    expect(report.rows.find(row => row.state === 'AVAILABLE')?.discrepancy.AVAILABLE).toBe(1);
  });

  it('reconciles available, pending, held, and frozen states independently', () => {
    const report = buildWalletReconciliationReport(
      [balance({ availableMinor: 0, pendingMinor: 10, heldMinor: 5, frozenMinor: 2 })],
      [],
      [
        allocation({ state: 'PENDING', deltaMinor: 10, transactionId: null }),
        allocation({ state: 'HELD', deltaMinor: 5, transactionId: null }),
        allocation({ state: 'FROZEN', deltaMinor: 2, transactionId: null })
      ]
    );
    expect(report.status).toBe('MATCHED');
    expect(report.rows.filter(row => row.status === 'MATCHED')).toHaveLength(4);
  });

  it('marks a nonzero snapshot with no allocation or economic evidence inconclusive', () => {
    const report = buildWalletReconciliationReport([balance()], [], []);
    const row = report.rows.find(item => item.state === 'AVAILABLE');
    expect(row?.status).toBe('INCONCLUSIVE');
    expect(row?.notes[0]).toContain('Snapshot-only');
  });

  it('marks ledger and allocation keys without a snapshot inconclusive', () => {
    const report = buildWalletReconciliationReport([], [{ accountId: 'ledger-only', currency: 'USD', direction: 'DEBIT', amountMinor: 25 }], [allocation({ accountId: 'ledger-only', deltaMinor: 25 })]);
    const row = report.rows.find(item => item.accountId === 'ledger-only' && item.state === 'AVAILABLE');
    expect(row?.status).toBe('INCONCLUSIVE');
    expect(row?.notes[0]).toContain('no balance snapshot');
  });

  it('reconciles multiple currencies separately', () => {
    const report = buildWalletReconciliationReport(
      [balance(), balance({ currency: 'EUR', availableMinor: 40 })],
      [
        { accountId: 'account-1', currency: 'USD', direction: 'DEBIT', amountMinor: 100 },
        { accountId: 'account-1', currency: 'EUR', direction: 'DEBIT', amountMinor: 40 }
      ],
      [allocation(), allocation({ currency: 'EUR', deltaMinor: 40 })]
    );
    expect(report.status).toBe('MATCHED');
    expect(report.summary.walletCurrencies).toBe(2);
  });

  it('reconciles funding that moves from available to held', () => {
    const report = buildWalletReconciliationReport(
      [balance({ availableMinor: 0, heldMinor: 5 })],
      [
        { accountId: 'account-1', currency: 'USD', direction: 'DEBIT', amountMinor: 5 },
        { accountId: 'account-1', currency: 'USD', direction: 'DEBIT', amountMinor: 5 },
        { accountId: 'account-1', currency: 'USD', direction: 'CREDIT', amountMinor: 5 }
      ],
      [
        allocation({ deltaMinor: 5, transactionId: 'funding-tx' }),
        allocation({ deltaMinor: -5, transactionId: 'dispute-tx' }),
        allocation({ state: 'HELD', deltaMinor: 5, transactionId: 'dispute-tx' })
      ]
    );

    expect(report.status).toBe('MATCHED');
    expect(report.rows.find(row => row.state === 'AVAILABLE')?.discrepancy.AVAILABLE).toBeNull();
    expect(report.rows.find(row => row.state === 'HELD')?.allocationDerived.HELD).toBe(5);
  });

  it('keeps an unverified opening balance inconclusive', () => {
    const report = buildWalletReconciliationReport([balance({ availableMinor: 25 })], [], [allocation({ deltaMinor: 25, isOpeningBaseline: true, baselineVerified: false, transactionId: null })]);
    expect(report.status).toBe('INCONCLUSIVE');
    expect(report.rows.find(row => row.state === 'AVAILABLE')?.notes[0]).toContain('not verified');
  });
});
