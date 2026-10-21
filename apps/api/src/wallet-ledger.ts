import { Prisma, WalletBalanceState, WalletPostingDirection } from '@prisma/client';
import { currencyCodeSchema, positiveMinorSchema } from './wallet-domain.js';

export type WalletAllocationWrite = {
  accountId: string;
  transactionId?: string | null;
  currency: string;
  state: WalletBalanceState;
  deltaMinor: number;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  isOpeningBaseline?: boolean;
  baselineEvidenceRef?: string | null;
  baselineVerified?: boolean;
};

export type WalletPostingForAllocation = {
  accountId: string;
  direction: WalletPostingDirection | 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
};

function assertAllocation(write: WalletAllocationWrite) {
  if (!write.accountId || !write.idempotencyKey) throw new Error('Wallet allocation identity is required');
  positiveMinorSchema.parse(Math.abs(write.deltaMinor));
  currencyCodeSchema.parse(write.currency);
  if (write.deltaMinor === 0) throw new Error('Wallet allocations cannot be zero');
  if (write.baselineVerified && !write.isOpeningBaseline) throw new Error('Only opening baselines may be verified');
}

export function buildPostingAllocations(transactionId: string, idempotencyPrefix: string, postings: WalletPostingForAllocation[]): WalletAllocationWrite[] {
  return postings.map((posting, index) => {
    const amount = posting.direction === 'DEBIT'
      ? posting.amountMinor
      : -posting.amountMinor;
    const allocation: WalletAllocationWrite = {
      accountId: posting.accountId,
      transactionId,
      currency: posting.currency,
      state: WalletBalanceState.AVAILABLE,
      deltaMinor: amount,
      idempotencyKey: `${idempotencyPrefix}:allocation:${index}`,
      referenceType: 'LEDGER_POSTING',
      referenceId: transactionId
    };
    assertAllocation(allocation);
    return allocation;
  });
}

export type WalletStateTransitionInput = {
  accountId: string;
  currency: string;
  fromState: WalletBalanceState;
  toState: WalletBalanceState;
  amountMinor: number;
  referenceId: string;
  idempotencyKey: string;
};

const stateField: Record<WalletBalanceState, 'availableMinor' | 'pendingMinor' | 'heldMinor' | 'frozenMinor'> = {
  [WalletBalanceState.AVAILABLE]: 'availableMinor',
  [WalletBalanceState.PENDING]: 'pendingMinor',
  [WalletBalanceState.HELD]: 'heldMinor',
  [WalletBalanceState.FROZEN]: 'frozenMinor'
};

export function buildStateTransitionAllocations(input: WalletStateTransitionInput): WalletAllocationWrite[] {
  positiveMinorSchema.parse(input.amountMinor);
  currencyCodeSchema.parse(input.currency);
  if (input.fromState === input.toState) throw new Error('Wallet state transition must change state');
  const allocations = [
    {
      accountId: input.accountId,
      currency: input.currency,
      state: input.fromState,
      deltaMinor: -input.amountMinor,
      idempotencyKey: `${input.idempotencyKey}:from`,
      referenceType: 'STATE_TRANSITION',
      referenceId: input.referenceId
    },
    {
      accountId: input.accountId,
      currency: input.currency,
      state: input.toState,
      deltaMinor: input.amountMinor,
      idempotencyKey: `${input.idempotencyKey}:to`,
      referenceType: 'STATE_TRANSITION',
      referenceId: input.referenceId
    }
  ] satisfies WalletAllocationWrite[];
  allocations.forEach(assertAllocation);
  return allocations;
}

export async function appendWalletAllocations(tx: Prisma.TransactionClient, allocations: WalletAllocationWrite[]) {
  allocations.forEach(assertAllocation);
  if (allocations.length === 0) throw new Error('At least one wallet allocation is required');
  return tx.walletBalanceAllocation.createMany({
    data: allocations.map(allocation => ({
      accountId: allocation.accountId,
      transactionId: allocation.transactionId ?? null,
      currency: allocation.currency,
      state: allocation.state,
      deltaMinor: allocation.deltaMinor,
      idempotencyKey: allocation.idempotencyKey,
      referenceType: allocation.referenceType ?? null,
      referenceId: allocation.referenceId ?? null,
      isOpeningBaseline: allocation.isOpeningBaseline ?? false,
      baselineEvidenceRef: allocation.baselineEvidenceRef ?? null,
      baselineVerified: allocation.baselineVerified ?? false
    }))
  });
}

export async function recordWalletStateTransition(tx: Prisma.TransactionClient, input: WalletStateTransitionInput) {
  const fromField = stateField[input.fromState];
  const toField = stateField[input.toState];
  const balance = await tx.walletBalance.updateMany({
    where: { accountId: input.accountId, currency: input.currency, [fromField]: { gte: input.amountMinor } },
    data: {
      [fromField]: { decrement: input.amountMinor },
      [toField]: { increment: input.amountMinor }
    } as Prisma.WalletBalanceUpdateManyMutationInput
  });
  if (balance.count !== 1) throw new Error('Insufficient balance in the source wallet state');
  await appendWalletAllocations(tx, buildStateTransitionAllocations(input));
}
