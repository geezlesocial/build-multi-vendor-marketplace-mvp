import type Stripe from 'stripe';
import {
  PaymentMethod,
  Prisma,
  WalletAccountStatus,
  WalletAccountType,
  WalletFundingStatus,
  WalletLedgerEntryType,
  WalletLedgerStatus,
  WalletPostingDirection
} from '@prisma/client';
import { env, isDisposableDatabaseUrl } from './config.js';
import { stripe } from './payments.js';
import { prisma } from './security.js';
import { currencyCodeSchema } from './wallet-domain.js';
import { appendWalletAllocations } from './wallet-ledger.js';

export type WalletFundingEventOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REVERSED' | 'PARTIAL_REFUND' | 'DISPUTED' | 'DISPUTE_WON' | 'DISPUTE_LOST' | 'IGNORED';

export type WalletFundingProviderEvent = {
  provider: 'STRIPE';
  eventId: string;
  eventType: string;
  outcome: WalletFundingEventOutcome;
  providerIntentId: string | null;
  disputeId: string | null;
  fundingIntentId: string | null;
  amountMinor: number | null;
  amountReceivedMinor: number | null;
  currency: string | null;
  purpose: string | null;
  disputeResolution?: 'WON' | 'LOST' | null;
  liveMode: boolean;
};

export type WalletFundingProvider = {
  readonly name: 'STRIPE';
  createPaymentIntent(input: {
    fundingIntentId: string;
    userId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
  }): Promise<WalletFundingPaymentIntent>;
  retrievePaymentIntent(providerIntentId: string): Promise<WalletFundingPaymentIntent>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): WalletFundingProviderEvent;
};

export type WalletFundingPaymentIntent = {
  providerIntentId: string;
  clientSecret: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  liveMode: boolean;
  metadata: Record<string, string>;
};

export type WalletFundingRecoveryExpectation = {
  requestingUserId: string;
  fundingIntentId: string;
  userId: string;
  providerIntentId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
};

export class WalletFundingRecoveryError extends Error {
  constructor(message = 'Sandbox payment intent could not be safely recovered') {
    super(message);
    this.name = 'WalletFundingRecoveryError';
  }
}

export class WalletFundingRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletFundingRetryableError';
  }
}

type WalletFundingTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type WalletFundingAuditData = Prisma.AuditLogCreateArgs['data'];
type WalletFundingAuditWriter = (tx: WalletFundingTransaction, data: WalletFundingAuditData) => Promise<unknown>;

const defaultWalletFundingAuditWriter: WalletFundingAuditWriter = (tx, data) => tx.auditLog.create({ data });
let walletFundingAuditWriter: WalletFundingAuditWriter = defaultWalletFundingAuditWriter;
let walletFundingProviderOverride: WalletFundingProvider | null | undefined;

export function setWalletFundingAuditWriterForTests(writer: WalletFundingAuditWriter | null) {
  if (env.NODE_ENV !== 'test') throw new Error('Wallet funding audit-writer injection is test-only');
  walletFundingAuditWriter = writer ?? defaultWalletFundingAuditWriter;
}

export function setWalletFundingProviderForTests(provider: WalletFundingProvider | null) {
  if (env.NODE_ENV !== 'test') throw new Error('Wallet funding provider injection is test-only');
  walletFundingProviderOverride = provider;
}

function writeWalletFundingAudit(tx: WalletFundingTransaction, data: WalletFundingAuditData) {
  return walletFundingAuditWriter(tx, data);
}

function normalizedCurrency(value: string | null | undefined) {
  return value ? value.toUpperCase() : null;
}

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function providerIntentIdForObject(object: { id?: string; object?: string; payment_intent?: string | Stripe.PaymentIntent | null }) {
  if (object.object === 'payment_intent') return object.id ?? null;
  const paymentIntent = object.payment_intent;
  return typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id ?? null;
}

export class StripeWalletFundingProvider implements WalletFundingProvider {
  readonly name = 'STRIPE' as const;

  constructor(
    private readonly client: Stripe,
    private readonly endpointSecret: string | undefined = env.STRIPE_WEBHOOK_SECRET
  ) {}

  async createPaymentIntent(input: {
    fundingIntentId: string;
    userId: string;
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
  }) {
    if (env.NODE_ENV !== 'test' || !env.WALLET_FUNDING_SANDBOX_MODE || !env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      throw new Error('Stripe wallet funding is restricted to an explicit test-mode sandbox configuration');
    }

    const paymentIntent = await this.client.paymentIntents.create({
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: {
        scrolithFundingIntentId: input.fundingIntentId,
        scrolithFundingUserId: input.userId,
        scrolithIdempotencyKey: input.idempotencyKey,
        scrolithPurpose: 'wallet_top_up'
      }
    }, { idempotencyKey: `wallet-funding-${input.fundingIntentId}` });

    return this.toWalletFundingPaymentIntent(paymentIntent);
  }

  async retrievePaymentIntent(providerIntentId: string): Promise<WalletFundingPaymentIntent> {
    if (env.NODE_ENV !== 'test' || !env.WALLET_FUNDING_SANDBOX_MODE || !env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
      throw new Error('Stripe wallet funding is restricted to an explicit test-mode sandbox configuration');
    }
    const paymentIntent = await this.client.paymentIntents.retrieve(providerIntentId);
    return this.toWalletFundingPaymentIntent(paymentIntent);
  }

  private toWalletFundingPaymentIntent(paymentIntent: Stripe.PaymentIntent): WalletFundingPaymentIntent {
    return {
      providerIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amountMinor: paymentIntent.amount,
      currency: normalizedCurrency(paymentIntent.currency) ?? '',
      status: paymentIntent.status,
      liveMode: paymentIntent.livemode,
      metadata: { ...paymentIntent.metadata }
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.endpointSecret || this.endpointSecret.includes('placeholder') || !signature) {
      throw new Error('Stripe wallet webhook verification is not configured');
    }

    const event = this.client.webhooks.constructEvent(rawBody, signature, this.endpointSecret);
    const object = event.data.object as Stripe.Event.Data.Object & {
      id?: string;
      amount?: number;
      amount_received?: number;
      amount_refunded?: number;
      currency?: string;
      metadata?: Stripe.Metadata;
      payment_intent?: string | Stripe.PaymentIntent | null;
      status?: string;
    };
    const providerIntentId = providerIntentIdForObject(object);
    const disputeId = event.type.startsWith('charge.dispute.') ? object.id ?? null : null;
    const fundingIntentId = metadataValue(object.metadata, 'scrolithFundingIntentId');
    const purpose = metadataValue(object.metadata, 'scrolithPurpose');
    const base = {
      provider: 'STRIPE' as const,
      eventId: event.id,
      eventType: event.type,
      providerIntentId,
      disputeId,
      fundingIntentId,
      currency: normalizedCurrency(object.currency),
      purpose,
      disputeResolution: null,
      liveMode: Boolean(event.livemode)
    };

    if (event.type === 'payment_intent.succeeded') {
      return { ...base, outcome: 'SUCCEEDED' as const, amountMinor: object.amount ?? null, amountReceivedMinor: object.amount_received ?? null };
    }
    if (event.type === 'payment_intent.payment_failed') {
      return { ...base, outcome: 'FAILED' as const, amountMinor: object.amount ?? null, amountReceivedMinor: null };
    }
    if (event.type === 'payment_intent.canceled') {
      return { ...base, outcome: 'CANCELLED' as const, amountMinor: object.amount ?? null, amountReceivedMinor: null };
    }
    if (event.type === 'charge.refunded') {
      const chargedAmount = object.amount ?? null;
      const refundedAmount = object.amount_refunded ?? null;
      return {
        ...base,
        outcome: chargedAmount !== null && refundedAmount !== null && refundedAmount > 0 && refundedAmount < chargedAmount
          ? 'PARTIAL_REFUND' as const
          : 'REVERSED' as const,
        amountMinor: refundedAmount,
        amountReceivedMinor: null
      };
    }
    if (event.type === 'charge.dispute.created') {
      return {
        ...base,
        outcome: 'DISPUTED' as const,
        amountMinor: object.amount ?? null,
        amountReceivedMinor: null
      };
    }
    if (event.type === 'charge.dispute.closed') {
      const resolution: 'WON' | 'LOST' | null = object.status?.toLowerCase() === 'won' ? 'WON' : object.status?.toLowerCase() === 'lost' ? 'LOST' : null;
      return resolution
        ? { ...base, outcome: resolution === 'WON' ? 'DISPUTE_WON' as const : 'DISPUTE_LOST' as const, amountMinor: object.amount ?? null, amountReceivedMinor: null, disputeResolution: resolution }
        : { ...base, outcome: 'IGNORED' as const, amountMinor: object.amount ?? null, amountReceivedMinor: null };
    }
    return { ...base, outcome: 'IGNORED' as const, amountMinor: object.amount ?? null, amountReceivedMinor: null };
  }
}

export function walletFundingSandboxEnabled(databaseUrl = env.DATABASE_URL) {
  return env.NODE_ENV === 'test'
    && env.WALLET_FUNDING_SANDBOX_MODE
    && env.WALLET_FUNDING_PROVIDER_READY
    && !env.MONEY_MOVEMENT_HARD_DISABLED
    && Boolean(env.WALLET_FUNDING_TREASURY_ACCOUNT_ID)
    && isDisposableDatabaseUrl(databaseUrl);
}

export function getStripeWalletFundingProvider(): WalletFundingProvider | null {
  if (env.NODE_ENV === 'test' && walletFundingProviderOverride !== undefined) return walletFundingProviderOverride;
  if (!stripe || !env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || !env.STRIPE_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET.includes('placeholder')) return null;
  return new StripeWalletFundingProvider(stripe);
}

const recoverablePaymentIntentStatuses = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

export function validateWalletFundingPaymentIntent(expectation: WalletFundingRecoveryExpectation, payment: WalletFundingPaymentIntent) {
  if (expectation.requestingUserId !== expectation.userId) throw new WalletFundingRecoveryError();
  if (
    !expectation.providerIntentId || payment.providerIntentId !== expectation.providerIntentId ||
    payment.metadata.scrolithFundingIntentId !== expectation.fundingIntentId ||
    payment.metadata.scrolithFundingUserId !== expectation.userId ||
    payment.metadata.scrolithIdempotencyKey !== expectation.idempotencyKey ||
    payment.metadata.scrolithPurpose !== 'wallet_top_up' ||
    payment.amountMinor !== expectation.amountMinor ||
    payment.currency !== expectation.currency.toUpperCase() ||
    payment.liveMode !== false ||
    !recoverablePaymentIntentStatuses.has(payment.status) ||
    typeof payment.clientSecret !== 'string' || payment.clientSecret.length === 0
  ) {
    throw new WalletFundingRecoveryError();
  }
  return { providerIntentId: payment.providerIntentId, clientSecret: payment.clientSecret, providerStatus: payment.status };
}

export async function recoverWalletFundingPaymentIntent(
  expectation: WalletFundingRecoveryExpectation,
  provider: Pick<WalletFundingProvider, 'retrievePaymentIntent'>
) {
  if (expectation.requestingUserId !== expectation.userId) throw new WalletFundingRecoveryError();
  try {
    const payment = await provider.retrievePaymentIntent(expectation.providerIntentId);
    return validateWalletFundingPaymentIntent(expectation, payment);
  } catch {
    // Never pass provider errors, references, or secrets through this boundary.
    throw new WalletFundingRecoveryError();
  }
}

type FundingIntentRecord = {
  id: string;
  userId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  provider: string;
  providerIntentId: string | null;
  disputeId: string | null;
  status: WalletFundingStatus;
  refundObservedMinor: number;
  refundAppliedMinor: number;
  refundShortfallMinor: number;
  disputeAmountMinor: number;
  disputeHeldMinor: number;
  disputeShortfallMinor: number;
  disputeStatus: string | null;
};

function rejected(intentId: string | undefined, reason: string) {
  return { outcome: 'REJECTED' as const, intentId, reason };
}

async function recordRejectedEvent(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  intentId: string | undefined,
  event: WalletFundingProviderEvent,
  reason: string
) {
  await writeWalletFundingAudit(tx, {
      actorId: null,
      action: 'WALLET_FUNDING_WEBHOOK_REJECTED',
      entity: 'WalletFundingWebhook',
      entityId: intentId ?? event.fundingIntentId,
      metadata: {
        provider: event.provider,
        providerEventId: event.eventId,
        eventType: event.eventType,
        outcome: event.outcome,
        fundingIntentId: event.fundingIntentId,
        providerIntentId: event.providerIntentId,
        reason
      }
  });
  return rejected(intentId, reason);
}

async function recordProviderReferenceReview(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  event: WalletFundingProviderEvent
) {
  const reason = 'PROVIDER_REFERENCE_REQUIRED';
  const inserted = await tx.processedWebhookEvent.createMany({
    data: {
      provider: PaymentMethod.STRIPE,
      eventId: event.eventId,
      eventType: event.eventType,
      reviewReason: reason
    },
    skipDuplicates: true
  });

  if (inserted.count !== 1) {
    const existing = await tx.processedWebhookEvent.findUnique({
      where: { provider_eventId: { provider: PaymentMethod.STRIPE, eventId: event.eventId } },
      select: { reviewReason: true }
    });
    return existing?.reviewReason
      ? { outcome: 'REVIEW_REQUIRED' as const, intentId: event.fundingIntentId ?? undefined, reason: existing.reviewReason }
      : { outcome: 'DUPLICATE' as const };
  }

  await writeWalletFundingAudit(tx, {
      actorId: null,
      action: 'WALLET_FUNDING_WEBHOOK_REVIEW_REQUIRED',
      entity: 'WalletFundingWebhook',
      entityId: event.fundingIntentId,
      metadata: {
        provider: event.provider,
        providerEventId: event.eventId,
        eventType: event.eventType,
        reason
      }
  });

  return { outcome: 'REVIEW_REQUIRED' as const, intentId: event.fundingIntentId ?? undefined, reason };
}

async function recordDisputeReview(
  tx: WalletFundingTransaction,
  intent: FundingIntentRecord,
  event: WalletFundingProviderEvent,
  reason: string
) {
  await tx.processedWebhookEvent.update({
    where: { provider_eventId: { provider: PaymentMethod.STRIPE, eventId: event.eventId } },
    data: { reviewReason: reason }
  });
  return recordRejectedEvent(tx, intent.id, event, reason);
}

function isRetryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function isPositiveSafeInteger(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value > 0;
}

function expectedOutcomeForEvent(eventType: string, outcome: WalletFundingEventOutcome) {
  if (eventType === 'payment_intent.succeeded') return outcome === 'SUCCEEDED';
  if (eventType === 'payment_intent.payment_failed') return outcome === 'FAILED';
  if (eventType === 'payment_intent.canceled') return outcome === 'CANCELLED';
  if (eventType === 'charge.refunded') return outcome === 'REVERSED' || outcome === 'PARTIAL_REFUND';
  if (eventType === 'charge.dispute.created') return outcome === 'DISPUTED';
  if (eventType === 'charge.dispute.closed') return outcome === 'DISPUTE_WON' || outcome === 'DISPUTE_LOST';
  return outcome === 'IGNORED';
}

async function lockFundingIntent(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], event: WalletFundingProviderEvent) {
  const rows = event.fundingIntentId
    ? await tx.$queryRaw<FundingIntentRecord[]>(Prisma.sql`
        SELECT "id", "userId", "accountId", "amountMinor", "currency", "provider", "providerIntentId", "disputeId", "status"::text AS "status", "refundObservedMinor", "refundAppliedMinor", "refundShortfallMinor", "disputeAmountMinor", "disputeHeldMinor", "disputeShortfallMinor", "disputeStatus"
        FROM "WalletFundingIntent"
        WHERE "id" = ${event.fundingIntentId}
        FOR UPDATE
      `)
    : await tx.$queryRaw<FundingIntentRecord[]>(Prisma.sql`
        SELECT "id", "userId", "accountId", "amountMinor", "currency", "provider", "providerIntentId", "disputeId", "status"::text AS "status", "refundObservedMinor", "refundAppliedMinor", "refundShortfallMinor", "disputeAmountMinor", "disputeHeldMinor", "disputeShortfallMinor", "disputeStatus"
        FROM "WalletFundingIntent"
        WHERE "providerIntentId" = ${event.providerIntentId}
        FOR UPDATE
      `);
  const intent = rows[0];
  return intent ? { ...intent, status: intent.status as WalletFundingStatus } : null;
}

async function lockAndValidateFundingTarget(tx: WalletFundingTransaction, intent: FundingIntentRecord) {
  const accounts = await tx.$queryRaw<Array<{ id: string; userId: string | null; type: WalletAccountType }>>(Prisma.sql`
    SELECT "id", "userId", "type"
    FROM "WalletAccount"
    WHERE "id" = ${intent.accountId}
    FOR UPDATE
  `);
  const account = accounts[0];
  return Boolean(account && account.userId === intent.userId && account.type === WalletAccountType.USER);
}

function validateNormalizedEvent(event: WalletFundingProviderEvent, intent: FundingIntentRecord) {
  if (!event.eventType || !expectedOutcomeForEvent(event.eventType, event.outcome)) return 'EVENT_TYPE_OUTCOME_MISMATCH';
  if (typeof event.liveMode !== 'boolean' || event.liveMode) return 'LIVE_PROVIDER_EVENT_REJECTED';
  if (event.provider !== 'STRIPE' || !event.eventId || !event.providerIntentId) return 'INVALID_PROVIDER_EVENT';
  if (!event.currency || !currencyCodeSchema.safeParse(event.currency).success) return 'CURRENCY_REQUIRED';
  if (normalizedCurrency(event.currency) !== normalizedCurrency(intent.currency)) return 'CURRENCY_MISMATCH';
  if (event.outcome !== 'IGNORED' && !isPositiveSafeInteger(event.amountMinor)) return 'AMOUNT_REQUIRED';
  if ((event.outcome === 'SUCCEEDED' || event.outcome === 'FAILED' || event.outcome === 'CANCELLED') && event.amountMinor !== intent.amountMinor) return 'AMOUNT_MISMATCH';
  if (event.outcome === 'REVERSED' && event.amountMinor !== intent.amountMinor) return 'REVERSAL_AMOUNT_MISMATCH';
  if ((event.outcome === 'DISPUTED' || event.outcome === 'DISPUTE_WON' || event.outcome === 'DISPUTE_LOST') && event.amountMinor !== null && event.amountMinor > intent.amountMinor) return 'AMOUNT_MISMATCH';
  if (event.outcome === 'SUCCEEDED') {
    if (event.fundingIntentId !== intent.id || event.purpose !== 'wallet_top_up') return 'FUNDING_METADATA_MISMATCH';
    if (event.amountMinor !== intent.amountMinor || event.amountReceivedMinor !== intent.amountMinor || !isPositiveSafeInteger(event.amountReceivedMinor)) return 'PAYMENT_CONFIRMATION_MISMATCH';
  }
  if ((event.outcome === 'FAILED' || event.outcome === 'CANCELLED') && (event.fundingIntentId !== intent.id || event.purpose !== 'wallet_top_up')) return 'FUNDING_METADATA_MISMATCH';
  if (event.eventType.startsWith('payment_intent.') && event.fundingIntentId !== intent.id) return 'FUNDING_METADATA_MISMATCH';
  if (event.eventType === 'charge.refunded' && event.amountMinor !== null && event.amountMinor === 0) return 'REFUND_AMOUNT_INVALID';
  if (event.outcome === 'DISPUTED' && event.amountMinor !== null && event.amountMinor === 0) return 'DISPUTE_AMOUNT_INVALID';
  if ((event.outcome === 'DISPUTE_WON' || event.outcome === 'DISPUTE_LOST') && event.disputeResolution !== (event.outcome === 'DISPUTE_WON' ? 'WON' : 'LOST')) return 'DISPUTE_RESOLUTION_INVALID';
  if (event.outcome === 'PARTIAL_REFUND' && event.amountMinor !== null && event.amountMinor >= intent.amountMinor) return 'REFUND_AMOUNT_INVALID';
  return null;
}

function disputeTransitionReason(event: WalletFundingProviderEvent, intent: FundingIntentRecord) {
  const isDisputeOutcome = event.outcome === 'DISPUTED' || event.outcome === 'DISPUTE_WON' || event.outcome === 'DISPUTE_LOST';
  if (!isDisputeOutcome) return null;

  if (intent.disputeId && event.disputeId !== intent.disputeId) return event.disputeId ? 'DISPUTE_ID_MISMATCH' : 'DISPUTE_ID_REQUIRED';

  const terminalResolution = intent.disputeStatus === 'WON' || intent.disputeStatus === 'LOST' ? intent.disputeStatus : null;
  if (!terminalResolution) return null;

  if (event.outcome === 'DISPUTED') return event.disputeId && !intent.disputeId ? 'DISPUTE_ID_UNCORRELATED_AFTER_RESOLUTION' : 'STALE_DISPUTE_CREATED_AFTER_RESOLUTION';
  if (event.disputeResolution !== terminalResolution) return 'DISPUTE_RESOLUTION_CONFLICT';
  return null;
}

async function applySuccessfulFunding(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord, event: WalletFundingProviderEvent) {
  const treasuryId = env.WALLET_FUNDING_TREASURY_ACCOUNT_ID;
  if (!treasuryId) throw new WalletFundingRetryableError('Wallet funding treasury account is not configured');
  const [account, treasury] = await Promise.all([
    tx.walletAccount.findUnique({ where: { id: intent.accountId }, select: { id: true, userId: true, type: true, status: true } }),
    tx.walletAccount.findUnique({ where: { id: treasuryId }, select: { id: true, type: true, status: true } })
  ]);
  if (!account || account.userId !== intent.userId || account.type !== WalletAccountType.USER) return rejected(intent.id, 'TARGET_WALLET_OWNERSHIP_OR_TYPE_MISMATCH');
  if (account.status !== WalletAccountStatus.ACTIVE) return rejected(intent.id, 'TARGET_WALLET_UNAVAILABLE');
  if (!treasury || treasury.type !== WalletAccountType.TREASURY || treasury.status !== WalletAccountStatus.ACTIVE) throw new WalletFundingRetryableError('Wallet funding treasury account is unavailable');

  const targetBalance = await tx.walletBalance.upsert({ where: { accountId_currency: { accountId: account.id, currency: intent.currency } }, update: {}, create: { accountId: account.id, currency: intent.currency } });
  const treasuryBalance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: treasury.id, currency: intent.currency } } });
  if (!treasuryBalance) throw new WalletFundingRetryableError('Wallet funding treasury balance is unavailable');
  const treasuryDebit = await tx.walletBalance.updateMany({ where: { id: treasuryBalance.id, availableMinor: { gte: intent.amountMinor } }, data: { availableMinor: { decrement: intent.amountMinor } } });
  if (treasuryDebit.count !== 1) throw new WalletFundingRetryableError('Wallet funding treasury balance is insufficient');
  await tx.walletBalance.update({ where: { id: targetBalance.id }, data: { availableMinor: { increment: intent.amountMinor } } });

  const ledger = await tx.walletLedgerTransaction.create({ data: {
    idempotencyKey: `wallet-funding:${intent.id}:${intent.providerIntentId}`,
    entryType: WalletLedgerEntryType.FUNDING,
    status: WalletLedgerStatus.POSTED,
    currency: intent.currency,
    referenceType: 'WalletFundingIntent',
    referenceId: intent.id,
    metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId }
  } });
  const postings = [
    { transactionId: ledger.id, accountId: account.id, direction: WalletPostingDirection.DEBIT, amountMinor: intent.amountMinor, currency: intent.currency },
    { transactionId: ledger.id, accountId: treasury.id, direction: WalletPostingDirection.CREDIT, amountMinor: intent.amountMinor, currency: intent.currency }
  ];
  await tx.walletLedgerPosting.createMany({ data: postings });
  await appendWalletAllocations(tx, postings.map((posting, index) => ({
    accountId: posting.accountId,
    transactionId: ledger.id,
    currency: posting.currency,
    state: 'AVAILABLE' as const,
    deltaMinor: posting.direction === WalletPostingDirection.DEBIT ? posting.amountMinor : -posting.amountMinor,
    idempotencyKey: `wallet-funding:${intent.id}:allocation:${index}`,
    referenceType: 'LEDGER_POSTING',
    referenceId: intent.id
  })));
  const intentUpdate = await tx.walletFundingIntent.updateMany({
    where: { id: intent.id, status: { in: [WalletFundingStatus.PENDING, WalletFundingStatus.FAILED] } },
    data: { status: WalletFundingStatus.SUCCEEDED, failureReason: null, resolvedAt: new Date() }
  });
  if (intentUpdate.count !== 1) throw new WalletFundingRetryableError('Funding intent changed while confirmation was being applied');
  await writeWalletFundingAudit(tx, { actorId: null, action: 'WALLET_FUNDING_CONFIRMED', entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId } });
  return { outcome: 'SUCCEEDED' as const, intentId: intent.id };
}

async function fundingLedger(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord) {
  return tx.walletLedgerTransaction.findUnique({
    where: { idempotencyKey: `wallet-funding:${intent.id}:${intent.providerIntentId}` },
    select: { id: true }
  });
}

async function recordFundingReview(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intentId: string, event: WalletFundingProviderEvent, action: string, failureReason: string, data: Record<string, unknown>) {
  await tx.walletFundingIntent.update({ where: { id: intentId }, data: { ...data, status: WalletFundingStatus.REVIEW, failureReason, resolvedAt: null } });
  await writeWalletFundingAudit(tx, { actorId: null, action, entity: 'WalletFundingIntent', entityId: intentId, metadata: { provider: event.provider, providerIntentId: event.providerIntentId, providerEventId: event.eventId, ...data } });
}

async function recordFundingShortfall(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord, event: WalletFundingProviderEvent, kind: 'REFUND' | 'DISPUTE', cumulativeMinor: number, deltaMinor: number, disputeResolution: 'WON' | 'LOST' | null = null) {
  await tx.walletAccount.updateMany({ where: { id: intent.accountId, status: WalletAccountStatus.ACTIVE }, data: { status: WalletAccountStatus.FROZEN } });
  if (kind === 'REFUND') {
    await recordFundingReview(tx, intent.id, event, 'WALLET_FUNDING_REFUND_SHORTFALL', 'PROVIDER_REFUND_SHORTFALL_REVIEW_REQUIRED', {
      refundObservedMinor: cumulativeMinor,
      refundShortfallMinor: { increment: deltaMinor }
    });
  } else {
    await recordFundingReview(tx, intent.id, event, disputeResolution === 'LOST' ? 'WALLET_FUNDING_DISPUTE_LOSS_SHORTFALL' : 'WALLET_FUNDING_DISPUTE_SHORTFALL', disputeResolution === 'LOST' ? 'PROVIDER_DISPUTE_LOSS_SHORTFALL_REVIEW_REQUIRED' : 'PROVIDER_DISPUTE_SHORTFALL_REVIEW_REQUIRED', {
      disputeId: event.disputeId ?? intent.disputeId,
      disputeAmountMinor: cumulativeMinor,
      disputeShortfallMinor: { increment: deltaMinor },
      disputeStatus: disputeResolution ?? 'OPEN'
    });
  }
  const outcome = kind === 'REFUND' ? cumulativeMinor === intent.amountMinor ? 'REVERSED' as const : 'PARTIAL_REFUND' as const : disputeResolution === 'LOST' ? 'DISPUTE_LOST' as const : 'DISPUTED' as const;
  return { outcome, intentId: intent.id, reviewRequired: true, shortfallMinor: deltaMinor };
}

async function applyRefundEvent(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord, event: WalletFundingProviderEvent) {
  const cumulativeMinor = event.amountMinor!;
  if (cumulativeMinor <= intent.refundObservedMinor) return { outcome: event.outcome === 'REVERSED' ? 'REVERSED' as const : 'PARTIAL_REFUND' as const, intentId: intent.id, alreadyApplied: intent.refundAppliedMinor >= cumulativeMinor, reviewRequired: intent.refundAppliedMinor < cumulativeMinor || intent.refundShortfallMinor > 0 };
  const deltaMinor = cumulativeMinor - intent.refundObservedMinor;
  const credited = await fundingLedger(tx, intent);
  if (!credited) {
    const fullBeforeCredit = cumulativeMinor === intent.amountMinor;
    await tx.walletFundingIntent.update({ where: { id: intent.id }, data: { refundObservedMinor: cumulativeMinor, status: fullBeforeCredit ? WalletFundingStatus.REVERSED : WalletFundingStatus.REVIEW, failureReason: fullBeforeCredit ? 'PROVIDER_REFUND_BEFORE_CREDIT' : 'PROVIDER_PARTIAL_REFUND_BEFORE_CREDIT_REVIEW_REQUIRED', resolvedAt: fullBeforeCredit ? new Date() : null } });
    await writeWalletFundingAudit(tx, { actorId: null, action: 'WALLET_FUNDING_REFUND_BEFORE_CREDIT', entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: event.providerIntentId, providerEventId: event.eventId, cumulativeMinor, deltaMinor } });
    return { outcome: fullBeforeCredit ? 'REVERSED' as const : 'PARTIAL_REFUND' as const, intentId: intent.id, credited: false, reviewRequired: !fullBeforeCredit };
  }

  const treasuryId = env.WALLET_FUNDING_TREASURY_ACCOUNT_ID;
  if (!treasuryId) throw new WalletFundingRetryableError('Wallet funding treasury account is not configured');
  const [account, treasury] = await Promise.all([
    tx.walletAccount.findUnique({ where: { id: intent.accountId }, select: { id: true } }),
    tx.walletAccount.findUnique({ where: { id: treasuryId }, select: { id: true, type: true, status: true } })
  ]);
  if (!account) throw new WalletFundingRetryableError('Wallet funding refund target is unavailable');
  if (!treasury || treasury.type !== WalletAccountType.TREASURY || treasury.status !== WalletAccountStatus.ACTIVE) throw new WalletFundingRetryableError('Wallet funding treasury account is unavailable');
  const [targetBalance, treasuryBalance] = await Promise.all([
    tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: account.id, currency: intent.currency } } }),
    tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: treasury.id, currency: intent.currency } } })
  ]);
  if (!targetBalance || !treasuryBalance) throw new WalletFundingRetryableError('Wallet funding refund balance is unavailable');
  // Partial refunds only recover spendable funds. A full cumulative refund may
  // also consume a dispute hold belonging to this funding intent, since those
  // funds are already reserved and cannot be spent. Never consume an unrelated
  // hold from the same wallet account.
  const heldMinor = cumulativeMinor === intent.amountMinor ? Math.min(intent.disputeHeldMinor, deltaMinor) : 0;
  const availableMinor = deltaMinor - heldMinor;
  const targetUpdate = await tx.walletBalance.updateMany({
    where: { id: targetBalance.id, heldMinor: { gte: heldMinor }, availableMinor: { gte: availableMinor } },
    data: { ...(heldMinor ? { heldMinor: { decrement: heldMinor } } : {}), ...(availableMinor ? { availableMinor: { decrement: availableMinor } } : {}) }
  });
  if (targetUpdate.count !== 1) return recordFundingShortfall(tx, intent, event, 'REFUND', cumulativeMinor, deltaMinor);
  await tx.walletBalance.update({ where: { id: treasuryBalance.id }, data: { availableMinor: { increment: deltaMinor } } });
  const ledger = await tx.walletLedgerTransaction.create({ data: {
    idempotencyKey: `wallet-funding-refund:${intent.id}:${cumulativeMinor}`,
    entryType: WalletLedgerEntryType.REFUND,
    status: WalletLedgerStatus.POSTED,
    currency: intent.currency,
    referenceType: 'WalletFundingRefund',
    referenceId: intent.id,
    metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, cumulativeMinor, deltaMinor }
  } });
  const postings = [
    { transactionId: ledger.id, accountId: account.id, direction: WalletPostingDirection.CREDIT, amountMinor: deltaMinor, currency: intent.currency },
    { transactionId: ledger.id, accountId: treasury.id, direction: WalletPostingDirection.DEBIT, amountMinor: deltaMinor, currency: intent.currency }
  ];
  await tx.walletLedgerPosting.createMany({ data: postings });
  const allocations = [
    ...(availableMinor ? [{ accountId: account.id, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE' as const, deltaMinor: -availableMinor, idempotencyKey: `wallet-funding-refund:${intent.id}:${cumulativeMinor}:available`, referenceType: 'WALLET_FUNDING_REFUND', referenceId: intent.id }] : []),
    ...(heldMinor ? [{ accountId: account.id, transactionId: ledger.id, currency: intent.currency, state: 'HELD' as const, deltaMinor: -heldMinor, idempotencyKey: `wallet-funding-refund:${intent.id}:${cumulativeMinor}:held`, referenceType: 'WALLET_FUNDING_REFUND', referenceId: intent.id }] : []),
    { accountId: treasury.id, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE' as const, deltaMinor: deltaMinor, idempotencyKey: `wallet-funding-refund:${intent.id}:${cumulativeMinor}:treasury`, referenceType: 'WALLET_FUNDING_REFUND', referenceId: intent.id }
  ];
  await appendWalletAllocations(tx, allocations);
  const appliedAfter = intent.refundAppliedMinor + deltaMinor;
  const fullyApplied = appliedAfter >= intent.amountMinor && intent.refundShortfallMinor === 0;
  await tx.walletFundingIntent.update({ where: { id: intent.id }, data: { refundObservedMinor: cumulativeMinor, refundAppliedMinor: { increment: deltaMinor }, ...(heldMinor ? { disputeHeldMinor: { decrement: heldMinor }, disputeStatus: 'REFUNDED' } : {}), status: fullyApplied ? WalletFundingStatus.REVERSED : WalletFundingStatus.REVIEW, failureReason: fullyApplied ? null : 'PROVIDER_PARTIAL_REFUND_APPLIED', resolvedAt: fullyApplied ? new Date() : null } });
  await writeWalletFundingAudit(tx, { actorId: null, action: fullyApplied ? 'WALLET_FUNDING_REFUNDED' : 'WALLET_FUNDING_PARTIAL_REFUND_APPLIED', entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, cumulativeMinor, deltaMinor, heldMinor, availableMinor } });
  return { outcome: fullyApplied ? 'REVERSED' as const : 'PARTIAL_REFUND' as const, intentId: intent.id, appliedMinor: deltaMinor, cumulativeMinor };
}

async function applyDisputeCreated(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord, event: WalletFundingProviderEvent) {
  const cumulativeMinor = event.amountMinor!;
  if (cumulativeMinor <= intent.disputeAmountMinor) return { outcome: 'DISPUTED' as const, intentId: intent.id, alreadyApplied: true, reviewRequired: intent.disputeShortfallMinor > 0 };
  const deltaMinor = cumulativeMinor - intent.disputeAmountMinor;
  const credited = await fundingLedger(tx, intent);
  if (!credited) {
    await recordFundingReview(tx, intent.id, event, 'WALLET_FUNDING_DISPUTE_BEFORE_CREDIT', 'PROVIDER_DISPUTE_BEFORE_CREDIT_REVIEW_REQUIRED', { disputeId: event.disputeId ?? intent.disputeId, disputeAmountMinor: cumulativeMinor, disputeStatus: 'OPEN' });
    return { outcome: 'DISPUTED' as const, intentId: intent.id, reviewRequired: true };
  }
  const balance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: intent.accountId, currency: intent.currency } } });
  if (!balance) throw new WalletFundingRetryableError('Wallet funding dispute hold balance is unavailable');
  const held = await tx.walletBalance.updateMany({ where: { id: balance.id, availableMinor: { gte: deltaMinor } }, data: { availableMinor: { decrement: deltaMinor }, heldMinor: { increment: deltaMinor } } });
  if (held.count !== 1) return recordFundingShortfall(tx, intent, event, 'DISPUTE', cumulativeMinor, deltaMinor);
  const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: `wallet-funding-dispute-hold:${intent.id}:${cumulativeMinor}`, entryType: WalletLedgerEntryType.ADJUSTMENT, status: WalletLedgerStatus.POSTED, currency: intent.currency, referenceType: 'WalletFundingDisputeHold', referenceId: intent.id, metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, cumulativeMinor, deltaMinor } } });
  await tx.walletLedgerPosting.createMany({ data: [
    { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.DEBIT, amountMinor: deltaMinor, currency: intent.currency },
    { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.CREDIT, amountMinor: deltaMinor, currency: intent.currency }
  ] });
  await appendWalletAllocations(tx, [
    { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE', deltaMinor: -deltaMinor, idempotencyKey: `wallet-funding-dispute-hold:${intent.id}:${cumulativeMinor}:available`, referenceType: 'DISPUTE_HOLD', referenceId: intent.id },
    { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'HELD', deltaMinor, idempotencyKey: `wallet-funding-dispute-hold:${intent.id}:${cumulativeMinor}:held`, referenceType: 'DISPUTE_HOLD', referenceId: intent.id }
  ]);
  await tx.walletFundingIntent.update({ where: { id: intent.id }, data: { disputeId: event.disputeId ?? intent.disputeId, disputeAmountMinor: cumulativeMinor, disputeHeldMinor: { increment: deltaMinor }, disputeStatus: 'OPEN', status: WalletFundingStatus.REVIEW, failureReason: 'PROVIDER_DISPUTE_HOLD', resolvedAt: null } });
  await writeWalletFundingAudit(tx, { actorId: null, action: 'WALLET_FUNDING_DISPUTE_HOLD', entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, cumulativeMinor, deltaMinor } });
  return { outcome: 'DISPUTED' as const, intentId: intent.id, heldMinor: deltaMinor };
}

async function applyDisputeResolution(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], intent: FundingIntentRecord, event: WalletFundingProviderEvent, resolution: 'WON' | 'LOST') {
  if (intent.disputeStatus === resolution && intent.disputeHeldMinor === 0 && intent.disputeShortfallMinor === 0) return { outcome: resolution === 'WON' ? 'DISPUTE_WON' as const : 'DISPUTE_LOST' as const, intentId: intent.id, alreadyApplied: true };
  const heldMinor = intent.disputeHeldMinor;
  const credited = await fundingLedger(tx, intent);
  if (!heldMinor) {
    if (resolution === 'LOST' && credited && intent.disputeShortfallMinor === 0) {
      const treasuryId = env.WALLET_FUNDING_TREASURY_ACCOUNT_ID;
      if (!treasuryId) throw new WalletFundingRetryableError('Wallet funding treasury account is not configured');
      const [balance, treasury] = await Promise.all([
        tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: intent.accountId, currency: intent.currency } } }),
        tx.walletAccount.findUnique({ where: { id: treasuryId }, select: { id: true, type: true, status: true } })
      ]);
      if (!balance) throw new WalletFundingRetryableError('Wallet funding dispute loss balance is unavailable');
      if (!treasury || treasury.type !== WalletAccountType.TREASURY || treasury.status !== WalletAccountStatus.ACTIVE) throw new WalletFundingRetryableError('Wallet funding treasury account is unavailable');
      const treasuryBalance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: treasury.id, currency: intent.currency } } });
      if (!treasuryBalance) throw new WalletFundingRetryableError('Wallet funding dispute loss treasury balance is unavailable');
      const lossAmount = event.amountMinor!;
      const removed = await tx.walletBalance.updateMany({ where: { id: balance.id, availableMinor: { gte: lossAmount } }, data: { availableMinor: { decrement: lossAmount } } });
      if (removed.count !== 1) return recordFundingShortfall(tx, intent, event, 'DISPUTE', lossAmount, lossAmount, 'LOST');
      await tx.walletBalance.update({ where: { id: treasuryBalance.id }, data: { availableMinor: { increment: lossAmount } } });
      const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: `wallet-funding-dispute-lost:${intent.id}:${lossAmount}:available`, entryType: WalletLedgerEntryType.REVERSAL, status: WalletLedgerStatus.POSTED, currency: intent.currency, referenceType: 'WalletFundingDisputeLost', referenceId: intent.id, metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, lossAmount } } });
      const postings = [
        { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.CREDIT, amountMinor: lossAmount, currency: intent.currency },
        { transactionId: ledger.id, accountId: treasury.id, direction: WalletPostingDirection.DEBIT, amountMinor: lossAmount, currency: intent.currency }
      ];
      await tx.walletLedgerPosting.createMany({ data: postings });
      await appendWalletAllocations(tx, [
        { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE', deltaMinor: -lossAmount, idempotencyKey: `wallet-funding-dispute-lost:${intent.id}:${lossAmount}:available:allocation`, referenceType: 'DISPUTE_LOST', referenceId: intent.id },
        { accountId: treasury.id, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE', deltaMinor: lossAmount, idempotencyKey: `wallet-funding-dispute-lost:${intent.id}:${lossAmount}:treasury:allocation`, referenceType: 'DISPUTE_LOST', referenceId: intent.id }
      ]);
    }
    const lostWithoutHold = resolution === 'LOST' && credited && intent.disputeShortfallMinor === 0;
    const lostFullyRecovered = lostWithoutHold && event.amountMinor === intent.amountMinor;
    const finalStatus = resolution === 'WON' && credited && intent.disputeShortfallMinor === 0 ? WalletFundingStatus.SUCCEEDED : lostFullyRecovered ? WalletFundingStatus.REVERSED : WalletFundingStatus.REVIEW;
    await tx.walletFundingIntent.update({ where: { id: intent.id }, data: { disputeId: event.disputeId ?? intent.disputeId, disputeAmountMinor: event.amountMinor!, disputeStatus: resolution, status: finalStatus, failureReason: finalStatus === WalletFundingStatus.SUCCEEDED || finalStatus === WalletFundingStatus.REVERSED ? null : `PROVIDER_DISPUTE_${resolution}_REVIEW_REQUIRED`, resolvedAt: finalStatus === WalletFundingStatus.REVIEW ? null : new Date() } });
    await writeWalletFundingAudit(tx, { actorId: null, action: `WALLET_FUNDING_DISPUTE_${resolution}`, entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, heldMinor: 0, reviewRequired: finalStatus === WalletFundingStatus.REVIEW } });
    return { outcome: resolution === 'WON' ? 'DISPUTE_WON' as const : 'DISPUTE_LOST' as const, intentId: intent.id, reviewRequired: finalStatus === WalletFundingStatus.REVIEW };
  }
  const balance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: intent.accountId, currency: intent.currency } } });
  if (!balance) throw new WalletFundingRetryableError('Wallet funding dispute resolution balance is unavailable');
  const treasuryId = env.WALLET_FUNDING_TREASURY_ACCOUNT_ID;
  if (!treasuryId) throw new WalletFundingRetryableError('Wallet funding treasury account is not configured');
  const treasury = await tx.walletAccount.findUnique({ where: { id: treasuryId }, select: { id: true, type: true, status: true } });
  if (!treasury || treasury.type !== WalletAccountType.TREASURY || treasury.status !== WalletAccountStatus.ACTIVE) throw new WalletFundingRetryableError('Wallet funding treasury account is unavailable');
  const treasuryBalance = await tx.walletBalance.findUnique({ where: { accountId_currency: { accountId: treasury.id, currency: intent.currency } } });
  if (!treasuryBalance) throw new WalletFundingRetryableError('Wallet funding dispute resolution treasury balance is unavailable');
  const finalKey = `wallet-funding-dispute-${resolution.toLowerCase()}:${intent.id}:${event.amountMinor}`;
  if (resolution === 'WON') {
    const release = await tx.walletBalance.updateMany({ where: { id: balance.id, heldMinor: { gte: heldMinor } }, data: { heldMinor: { decrement: heldMinor }, availableMinor: { increment: heldMinor } } });
    if (release.count !== 1) throw new WalletFundingRetryableError('Wallet funding dispute release could not be serialized');
    const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: finalKey, entryType: WalletLedgerEntryType.ADJUSTMENT, status: WalletLedgerStatus.POSTED, currency: intent.currency, referenceType: 'WalletFundingDisputeWon', referenceId: intent.id, metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, heldMinor } } });
    await tx.walletLedgerPosting.createMany({ data: [
      { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.DEBIT, amountMinor: heldMinor, currency: intent.currency },
      { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.CREDIT, amountMinor: heldMinor, currency: intent.currency }
    ] });
    await appendWalletAllocations(tx, [
      { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'HELD', deltaMinor: -heldMinor, idempotencyKey: `${finalKey}:held`, referenceType: 'DISPUTE_WON', referenceId: intent.id },
      { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE', deltaMinor: heldMinor, idempotencyKey: `${finalKey}:available`, referenceType: 'DISPUTE_WON', referenceId: intent.id }
    ]);
  } else {
    const remove = await tx.walletBalance.updateMany({ where: { id: balance.id, heldMinor: { gte: heldMinor } }, data: { heldMinor: { decrement: heldMinor } } });
    if (remove.count !== 1) throw new WalletFundingRetryableError('Wallet funding dispute loss could not be serialized');
    await tx.walletBalance.update({ where: { id: treasuryBalance.id }, data: { availableMinor: { increment: heldMinor } } });
    const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: finalKey, entryType: WalletLedgerEntryType.REVERSAL, status: WalletLedgerStatus.POSTED, currency: intent.currency, referenceType: 'WalletFundingDisputeLost', referenceId: intent.id, metadataJson: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, heldMinor } } });
    const postings = [
      { transactionId: ledger.id, accountId: intent.accountId, direction: WalletPostingDirection.CREDIT, amountMinor: heldMinor, currency: intent.currency },
      { transactionId: ledger.id, accountId: treasury.id, direction: WalletPostingDirection.DEBIT, amountMinor: heldMinor, currency: intent.currency }
    ];
    await tx.walletLedgerPosting.createMany({ data: postings });
    await appendWalletAllocations(tx, [
      { accountId: intent.accountId, transactionId: ledger.id, currency: intent.currency, state: 'HELD', deltaMinor: -heldMinor, idempotencyKey: `${finalKey}:held`, referenceType: 'DISPUTE_LOST', referenceId: intent.id },
      { accountId: treasury.id, transactionId: ledger.id, currency: intent.currency, state: 'AVAILABLE', deltaMinor: heldMinor, idempotencyKey: `${finalKey}:treasury`, referenceType: 'DISPUTE_LOST', referenceId: intent.id }
    ]);
  }
  const fullyLost = resolution === 'LOST' && event.amountMinor === intent.amountMinor && intent.disputeShortfallMinor === 0;
  const nextStatus = resolution === 'WON' && credited && intent.disputeShortfallMinor === 0 ? WalletFundingStatus.SUCCEEDED : fullyLost ? WalletFundingStatus.REVERSED : WalletFundingStatus.REVIEW;
  await tx.walletFundingIntent.update({ where: { id: intent.id }, data: { disputeId: event.disputeId ?? intent.disputeId, disputeAmountMinor: event.amountMinor!, disputeHeldMinor: 0, disputeStatus: resolution, status: nextStatus, failureReason: nextStatus === WalletFundingStatus.SUCCEEDED || nextStatus === WalletFundingStatus.REVERSED ? null : `PROVIDER_DISPUTE_${resolution}_REVIEW_REQUIRED`, resolvedAt: nextStatus === WalletFundingStatus.REVIEW ? null : new Date() } });
  await writeWalletFundingAudit(tx, { actorId: null, action: `WALLET_FUNDING_DISPUTE_${resolution}`, entity: 'WalletFundingIntent', entityId: intent.id, metadata: { provider: event.provider, providerIntentId: intent.providerIntentId, providerEventId: event.eventId, heldMinor, reviewRequired: nextStatus === WalletFundingStatus.REVIEW } });
  return { outcome: resolution === 'WON' ? 'DISPUTE_WON' as const : 'DISPUTE_LOST' as const, intentId: intent.id, heldMinor, reviewRequired: nextStatus === WalletFundingStatus.REVIEW };
}

export async function processWalletFundingEvent(event: WalletFundingProviderEvent) {
  if (!walletFundingSandboxEnabled()) throw new WalletFundingRetryableError('Wallet funding is disabled outside the explicit sandbox configuration');
  if (event.provider !== 'STRIPE' || !event.eventId) return rejected(undefined, 'INVALID_PROVIDER_EVENT');
  if (event.outcome === 'IGNORED') return { outcome: 'IGNORED' as const, intentId: undefined };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async tx => {
        if ((event.outcome === 'FAILED' || event.outcome === 'CANCELLED') &&
          (event.eventType === 'payment_intent.payment_failed' || event.eventType === 'payment_intent.canceled') &&
          !event.providerIntentId) {
          return recordProviderReferenceReview(tx, event);
        }

        if (!event.providerIntentId) return rejected(undefined, 'INVALID_PROVIDER_EVENT');

        const inserted = await tx.processedWebhookEvent.createMany({
          data: { provider: PaymentMethod.STRIPE, eventId: event.eventId, eventType: event.eventType },
          skipDuplicates: true
        });
        if (inserted.count !== 1) {
          const existing = await tx.processedWebhookEvent.findUnique({
            where: { provider_eventId: { provider: PaymentMethod.STRIPE, eventId: event.eventId } },
            select: { reviewReason: true }
          });
          const duplicateIntent = existing?.reviewReason && event.providerIntentId
            ? await tx.walletFundingIntent.findUnique({ where: { providerIntentId: event.providerIntentId }, select: { id: true } })
            : null;
          return existing?.reviewReason
            ? rejected(duplicateIntent?.id ?? event.fundingIntentId ?? undefined, existing.reviewReason)
            : { outcome: 'DUPLICATE' as const };
        }

        const intent = await lockFundingIntent(tx, event);
        if (!intent) return recordRejectedEvent(tx, undefined, event, 'NO_MATCHING_FUNDING_INTENT');
        if (intent.provider !== 'STRIPE') return recordRejectedEvent(tx, intent.id, event, 'PROVIDER_REFERENCE_MISMATCH');
        if (intent.providerIntentId !== event.providerIntentId) {
          if (!intent.providerIntentId && event.eventType.startsWith('payment_intent.') && event.fundingIntentId === intent.id) {
            throw new WalletFundingRetryableError('Provider reference is not persisted yet; retry the webhook after reference recovery');
          }
          return recordRejectedEvent(tx, intent.id, event, 'PROVIDER_REFERENCE_MISMATCH');
        }
        if (event.fundingIntentId && event.fundingIntentId !== intent.id) return recordRejectedEvent(tx, intent.id, event, 'FUNDING_INTENT_METADATA_MISMATCH');

        if (!await lockAndValidateFundingTarget(tx, intent)) {
          const reason = 'FUNDING_TARGET_OWNERSHIP_OR_TYPE_MISMATCH';
          await tx.processedWebhookEvent.update({
            where: { provider_eventId: { provider: PaymentMethod.STRIPE, eventId: event.eventId } },
            data: { reviewReason: reason }
          });
          await recordFundingReview(tx, intent.id, event, 'WALLET_FUNDING_TARGET_REVIEW_REQUIRED', reason, {});
          return { outcome: 'REVIEW_REQUIRED' as const, intentId: intent.id, reason };
        }

        const disputeReason = disputeTransitionReason(event, intent);
        if (disputeReason) return recordDisputeReview(tx, intent, event, disputeReason);

        const validationError = validateNormalizedEvent(event, intent);
        if (validationError) return recordRejectedEvent(tx, intent.id, event, validationError);
        if (event.outcome === 'SUCCEEDED') {
          if (intent.status === WalletFundingStatus.SUCCEEDED || intent.status === WalletFundingStatus.REVIEW && await fundingLedger(tx, intent)) return { outcome: 'SUCCEEDED' as const, intentId: intent.id, alreadyApplied: true };
          if (intent.status !== WalletFundingStatus.PENDING && intent.status !== WalletFundingStatus.FAILED) return rejected(intent.id, 'FUNDING_INTENT_NOT_ACCEPTING_PAYMENT');
          return applySuccessfulFunding(tx, intent, event);
        }

        if (event.outcome === 'FAILED' || event.outcome === 'CANCELLED') {
          const nextStatus = event.outcome === 'FAILED' ? WalletFundingStatus.FAILED : WalletFundingStatus.CANCELLED;
          if (intent.status === WalletFundingStatus.PENDING) {
            await tx.walletFundingIntent.updateMany({ where: { id: intent.id, status: WalletFundingStatus.PENDING }, data: { status: nextStatus, failureReason: event.outcome === 'FAILED' ? 'PROVIDER_PAYMENT_FAILED' : 'PROVIDER_PAYMENT_CANCELLED', resolvedAt: new Date() } });
          }
          return { outcome: event.outcome, intentId: intent.id };
        }

        if (event.outcome === 'PARTIAL_REFUND' || event.outcome === 'REVERSED') return applyRefundEvent(tx, intent, event);

        if (event.outcome === 'DISPUTED') {
          if (intent.status === WalletFundingStatus.REVERSED) return rejected(intent.id, 'FUNDING_INTENT_ALREADY_REVERSED');
          return applyDisputeCreated(tx, intent, event);
        }

        if (event.outcome === 'DISPUTE_WON') return applyDisputeResolution(tx, intent, event, 'WON');
        if (event.outcome === 'DISPUTE_LOST') return applyDisputeResolution(tx, intent, event, 'LOST');
        return rejected(intent.id, 'UNSUPPORTED_PROVIDER_OUTCOME');
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
    }
  }
  throw new WalletFundingRetryableError('Wallet funding event could not be serialized after retries');
}

export async function createWalletFundingPayment(input: { fundingIntentId: string; userId: string; idempotencyKey: string; amountMinor: number; currency: string }) {
  const provider = getStripeWalletFundingProvider();
  if (!provider) throw new Error('Stripe test-mode wallet funding provider is not configured');
  return provider.createPaymentIntent(input);
}

export async function persistWalletFundingProviderReference(
  fundingIntentId: string,
  providerIntentId: string,
  writer: (fundingIntentId: string, providerIntentId: string) => Promise<unknown> = async (id, providerId) => prisma.walletFundingIntent.update({ where: { id }, data: { providerIntentId: providerId, failureReason: null } })
) {
  if (!providerIntentId) throw new Error('Provider intent reference is required');
  return writer(fundingIntentId, providerIntentId);
}
