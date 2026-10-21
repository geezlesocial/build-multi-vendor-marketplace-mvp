import { WalletBalanceState, WalletPostingDirection } from '@prisma/client';

type BalanceState = 'AVAILABLE' | 'PENDING' | 'HELD' | 'FROZEN';
const states: BalanceState[] = ['AVAILABLE', 'PENDING', 'HELD', 'FROZEN'];
const stateFields: Record<BalanceState, 'availableMinor' | 'pendingMinor' | 'heldMinor' | 'frozenMinor'> = {
  AVAILABLE: 'availableMinor',
  PENDING: 'pendingMinor',
  HELD: 'heldMinor',
  FROZEN: 'frozenMinor'
};

export type ReconciliationBalance = {
  accountId: string;
  userId: string | null;
  currency: string;
  availableMinor: number;
  pendingMinor: number;
  heldMinor: number;
  frozenMinor: number;
};

export type ReconciliationPosting = {
  accountId: string;
  currency: string;
  direction: WalletPostingDirection | 'DEBIT' | 'CREDIT';
  amountMinor: number;
};

export type ReconciliationAllocation = {
  accountId: string;
  currency: string;
  state: WalletBalanceState | BalanceState | 'AVAILABLE' | 'PENDING' | 'HELD' | 'FROZEN';
  deltaMinor: number;
  isOpeningBaseline: boolean;
  baselineVerified: boolean;
  transactionId?: string | null;
};

type StateValues = Record<BalanceState, number | null>;

export type WalletReconciliationRow = {
  accountId: string;
  userId: string | null;
  currency: string;
  state: BalanceState;
  snapshot: StateValues;
  ledgerDerived: StateValues;
  allocationDerived: StateValues;
  verifiedOpeningBaseline: StateValues;
  expectedFromEconomicSources: StateValues;
  discrepancy: StateValues;
  status: 'MATCHED' | 'DISCREPANCY' | 'INCONCLUSIVE';
  notes: string[];
};

export type WalletReconciliationReport = {
  status: 'MATCHED' | 'DISCREPANCY' | 'INCONCLUSIVE';
  basis: string;
  rows: WalletReconciliationRow[];
  summary: {
    walletCurrencies: number;
    matched: number;
    discrepancies: number;
    inconclusive: number;
  };
};

function key(accountId: string, currency: string) {
  return `${accountId}\u0000${currency}`;
}

function emptyValues(): StateValues {
  return { AVAILABLE: null, PENDING: null, HELD: null, FROZEN: null };
}

function stateName(value: ReconciliationAllocation['state']): BalanceState {
  return String(value) as BalanceState;
}

export function buildWalletReconciliationReport(
  balances: ReconciliationBalance[],
  postings: ReconciliationPosting[],
  allocations: ReconciliationAllocation[] = []
): WalletReconciliationReport {
  const balanceByKey = new Map(balances.map(balance => [key(balance.accountId, balance.currency), balance]));
  const postingTotals = new Map<string, number>();
  const postingKeys = new Set<string>();
  for (const posting of postings) {
    const postingKey = key(posting.accountId, posting.currency);
    const signedAmount = posting.direction === 'DEBIT'
      ? posting.amountMinor
      : -posting.amountMinor;
    postingKeys.add(postingKey);
    postingTotals.set(postingKey, (postingTotals.get(postingKey) ?? 0) + signedAmount);
  }

  const allocationTotals = new Map<string, number>();
  const allocationTotalsByBaseKey = new Map<string, number>();
  const allocationKeys = new Set<string>();
  const allocationBaseKeys = new Set<string>();
  const baselineTotals = new Map<string, number>();
  const verifiedBaselineTotalsByBaseKey = new Map<string, number>();
  const unverifiedBaselineKeys = new Set<string>();
  const unverifiedBaselineBaseKeys = new Set<string>();
  for (const allocation of allocations) {
    const baseKey = key(allocation.accountId, allocation.currency);
    const allocationKey = `${key(allocation.accountId, allocation.currency)}\u0000${stateName(allocation.state)}`;
    allocationKeys.add(allocationKey);
    allocationBaseKeys.add(baseKey);
    allocationTotals.set(allocationKey, (allocationTotals.get(allocationKey) ?? 0) + allocation.deltaMinor);
    allocationTotalsByBaseKey.set(baseKey, (allocationTotalsByBaseKey.get(baseKey) ?? 0) + allocation.deltaMinor);
    if (allocation.isOpeningBaseline && allocation.baselineVerified) {
      baselineTotals.set(allocationKey, (baselineTotals.get(allocationKey) ?? 0) + allocation.deltaMinor);
      verifiedBaselineTotalsByBaseKey.set(baseKey, (verifiedBaselineTotalsByBaseKey.get(baseKey) ?? 0) + allocation.deltaMinor);
    }
    if (allocation.isOpeningBaseline && !allocation.baselineVerified) {
      unverifiedBaselineKeys.add(allocationKey);
      unverifiedBaselineBaseKeys.add(baseKey);
    }
  }

  const baseKeys = new Set<string>([
    ...balanceByKey.keys(),
    ...postingKeys,
    ...allocations.map(allocation => key(allocation.accountId, allocation.currency))
  ]);
  const rows: WalletReconciliationRow[] = [];

  for (const baseKey of baseKeys) {
    const balance = balanceByKey.get(baseKey);
    const [accountId = '', currency = ''] = baseKey.split('\u0000');
    const userId = balance?.userId ?? null;
    const postingPresent = postingKeys.has(baseKey);
    const allocationEvidence = allocationBaseKeys.has(baseKey);
    const economicEvidence = postingPresent || verifiedBaselineTotalsByBaseKey.has(baseKey);
    const economicTotal = (postingTotals.get(baseKey) ?? 0) + (verifiedBaselineTotalsByBaseKey.get(baseKey) ?? 0);
    const aggregateAllocationTotal = allocationTotalsByBaseKey.get(baseKey) ?? 0;
    const aggregateMismatch = allocationEvidence
      && economicEvidence
      && !unverifiedBaselineBaseKeys.has(baseKey)
      && aggregateAllocationTotal !== economicTotal;
    for (const state of states) {
      const stateKey = `${baseKey}\u0000${state}`;
      const snapshot = emptyValues();
      const ledgerDerived = emptyValues();
      const allocationDerived = emptyValues();
      const verifiedOpeningBaseline = emptyValues();
      const expectedFromEconomicSources = emptyValues();
      const discrepancy = emptyValues();
      if (balance) snapshot[state] = balance[stateFields[state]];
      if (postingPresent && state === 'AVAILABLE') ledgerDerived.AVAILABLE = postingTotals.get(baseKey) ?? 0;
      if (allocationKeys.has(stateKey)) allocationDerived[state] = allocationTotals.get(stateKey) ?? 0;
      if (baselineTotals.has(stateKey)) verifiedOpeningBaseline[state] = baselineTotals.get(stateKey) ?? 0;
      const expectedPresent = !allocationEvidence && ((postingPresent && state === 'AVAILABLE') || baselineTotals.has(stateKey));
      if (expectedPresent) expectedFromEconomicSources[state] = (ledgerDerived[state] ?? 0) + (verifiedOpeningBaseline[state] ?? 0);

      const snapshotPresent = balance !== undefined;
      const allocationPresent = allocationKeys.has(stateKey);
      const stateMismatch = snapshotPresent && allocationPresent && snapshot[state] !== allocationDerived[state]
        || snapshotPresent && expectedPresent && snapshot[state] !== expectedFromEconomicSources[state]
        || allocationPresent && expectedPresent && allocationDerived[state] !== expectedFromEconomicSources[state];
      const notes: string[] = [];
      if (unverifiedBaselineKeys.has(stateKey)) notes.push('Opening-balance evidence is not verified; this row remains INCONCLUSIVE.');
      if (aggregateMismatch && state === 'AVAILABLE') notes.push(`All-state allocation total (${aggregateAllocationTotal}) does not match economic posting total plus verified opening baseline (${economicTotal}).`);
      if (snapshotPresent && !allocationPresent && !expectedPresent && snapshot[state] !== 0) notes.push('Snapshot-only nonzero state has no append-only allocation evidence.');
      if (!snapshotPresent && (allocationPresent || expectedPresent)) notes.push('Ledger/allocation evidence has no balance snapshot for comparison.');
      if (snapshotPresent && allocationPresent && !expectedPresent && snapshot[state] !== allocationDerived[state]) notes.push('Snapshot and allocation totals differ.');
      if (snapshotPresent && !allocationPresent && expectedPresent) notes.push('Economic evidence exists but the state allocation is missing.');
      if (allocationPresent && !expectedPresent && state === 'AVAILABLE' && postingPresent && !allocationEvidence) notes.push('Available allocation is not paired with a recognized posted economic source.');

      const unresolved = notes.length > 0
        || (!snapshotPresent && (allocationPresent || expectedPresent))
        || (snapshotPresent && !allocationPresent && (expectedPresent || snapshot[state] !== 0));
      const mismatch = stateMismatch || (aggregateMismatch && state === 'AVAILABLE');
      if (mismatch) {
        discrepancy[state] = aggregateMismatch && state === 'AVAILABLE'
          ? aggregateAllocationTotal - economicTotal
          : snapshotPresent && expectedPresent
          ? (snapshot[state] ?? 0) - (expectedFromEconomicSources[state] ?? 0)
          : snapshotPresent && allocationPresent
            ? (snapshot[state] ?? 0) - (allocationDerived[state] ?? 0)
            : null;
      }
      rows.push({ accountId, userId, currency, state, snapshot, ledgerDerived, allocationDerived, verifiedOpeningBaseline, expectedFromEconomicSources, discrepancy, status: mismatch ? 'DISCREPANCY' : unresolved ? 'INCONCLUSIVE' : 'MATCHED', notes });
    }
  }

  const matched = rows.filter(row => row.status === 'MATCHED').length;
  const discrepancies = rows.filter(row => row.status === 'DISCREPANCY').length;
  const inconclusive = rows.filter(row => row.status === 'INCONCLUSIVE').length;
  return {
    status: discrepancies > 0 ? 'DISCREPANCY' : inconclusive > 0 ? 'INCONCLUSIVE' : 'MATCHED',
    basis: 'The report is read-only and uses the full union of WalletBalance snapshots, posted ledger postings, and append-only WalletBalanceAllocation keys. Available economic postings are signed DEBIT positive/CREDIT negative; verified opening baselines are added before comparison. Missing, single-source, or unverified opening evidence is INCONCLUSIVE rather than repaired.',
    rows,
    summary: { walletCurrencies: baseKeys.size, matched, discrepancies, inconclusive }
  };
}
