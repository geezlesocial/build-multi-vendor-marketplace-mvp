import { AffiliateAdjustmentType, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { accrueSellerCommissionsForPaidOrder, createPartialRefundReview, reverseSellerCommissionForOrder } from './seller-commission.js';
import { reverseAffiliateForOrderInTransaction, settleAffiliateForPaidOrderInTransaction } from './affiliate-ledger.js';

type Tx = Prisma.TransactionClient;
type Provider = 'STRIPE' | 'PAYPAL';

export type VerifiedPaymentEvent = {
  provider: Provider;
  eventId: string;
  eventType: string;
  /** Stable provider object reference shared by capture and later adjustments (PaymentIntent or PayPal order). */
  providerObjectRef: string | null;
  /** Reference used to find the locally created payment; Stripe capture uses the Checkout Session ID. */
  paymentLookupRef: string | null;
  metadataOrderId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  /** Original charge total when the provider event supplies it (Stripe Charge). */
  providerTotalMinor?: number | null;
  occurredAt?: Date | null;
  captureConfirmed?: boolean;
};

export type WebhookReconciliationResult = {
  orderId: string | null;
  becamePaid: boolean;
  adjustments: { eventId: string; eventType: string; amountMinor: number }[];
  reviewReason: string | null;
};

type PersistedEventIdentity = {
  id: string;
  provider: PaymentMethod;
  eventId: string;
  eventType: string | null;
  providerObjectRef: string | null;
  paymentLookupRef: string | null;
  metadataOrderId: string | null;
  amountMinor: number | null;
  currency: string | null;
  providerTotalMinor: number | null;
  providerOccurredAt: Date | null;
  captureConfirmed: boolean | null;
  identityVerified: boolean;
};

export function matchesPersistedPaymentEvent(event: VerifiedPaymentEvent, persisted: PersistedEventIdentity) {
  const lookupRef = event.paymentLookupRef?.trim() || null;
  const stableRef = event.providerObjectRef?.trim() || lookupRef;
  return persisted.provider === event.provider
    && persisted.eventId === event.eventId
    && persisted.eventType === event.eventType
    && (persisted.providerObjectRef === null || persisted.providerObjectRef === stableRef)
    && (persisted.paymentLookupRef === null || persisted.paymentLookupRef === lookupRef)
    && persisted.metadataOrderId === (event.metadataOrderId ?? null)
    && persisted.amountMinor === (event.amountMinor ?? null)
    && persisted.currency === (event.currency?.toUpperCase() ?? null)
    && persisted.providerTotalMinor === (event.providerTotalMinor ?? null)
    && (persisted.providerOccurredAt?.getTime() ?? null) === (event.occurredAt?.getTime() ?? null)
    && (persisted.captureConfirmed === null || persisted.captureConfirmed === (event.captureConfirmed ?? null));
}

function matchesKnownLegacyEventFacts(event: VerifiedPaymentEvent, persisted: PersistedEventIdentity) {
  const lookupRef = event.paymentLookupRef?.trim() || null;
  const stableRef = event.providerObjectRef?.trim() || lookupRef;
  return persisted.provider === event.provider
    && persisted.eventId === event.eventId
    && (persisted.eventType === null || persisted.eventType === event.eventType)
    && (persisted.providerObjectRef === null || persisted.providerObjectRef === stableRef)
    && (persisted.paymentLookupRef === null || persisted.paymentLookupRef === lookupRef)
    && (persisted.metadataOrderId === null || persisted.metadataOrderId === (event.metadataOrderId ?? null))
    && (persisted.amountMinor === null || persisted.amountMinor === (event.amountMinor ?? null))
    && (persisted.currency === null || persisted.currency === (event.currency?.toUpperCase() ?? null))
    && (persisted.providerTotalMinor === null || persisted.providerTotalMinor === (event.providerTotalMinor ?? null))
    && (persisted.providerOccurredAt === null || persisted.providerOccurredAt.getTime() === (event.occurredAt?.getTime() ?? null))
    && (persisted.captureConfirmed === null || persisted.captureConfirmed === (event.captureConfirmed ?? null));
}

async function auditLegacyWebhook(tx: Tx, prior: PersistedEventIdentity | null, action: string, reviewReason: string | null, parentOrderId: string | null) {
  if (!prior || prior.identityVerified) return;
  await tx.auditLog.create({ data: {
    actorId: null,
    action,
    entity: 'ProcessedWebhookEvent',
    entityId: prior.id,
    metadata: { provider: prior.provider, eventId: prior.eventId, reviewReason, parentOrderId }
  } });
}

const stripeCaptureTypes = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const captureTypes: Record<Provider, Set<string>> = {
  STRIPE: stripeCaptureTypes,
  PAYPAL: new Set(['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.COMPLETED'])
};
const refundTypes: Record<Provider, Set<string>> = {
  STRIPE: new Set(['charge.refunded']),
  PAYPAL: new Set(['PAYMENT.CAPTURE.REFUNDED'])
};
const disputeTypes: Record<Provider, Set<string>> = {
  STRIPE: new Set(['charge.dispute.created']),
  PAYPAL: new Set(['CUSTOMER.DISPUTE.CREATED'])
};

async function lockProviderReference(tx: Tx, provider: Provider, reference: string) {
  // Capture and refund/dispute deliveries for one provider object must serialize
  // before either obtains the parent-order lock. Keep the lock transaction-scoped.
  const key = `${provider}:${reference}`;
  await tx.$queryRaw`WITH provider_event_lock AS MATERIALIZED (
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
  ) SELECT 1::int AS acquired FROM provider_event_lock`;
}

function amountIsValid(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0;
}

async function storeUnresolved(tx: Tx, input: VerifiedPaymentEvent, reason: string, parentOrderId: string | null, existingId?: string) {
  const data = {
    provider: input.provider as PaymentMethod,
    eventId: input.eventId,
    eventType: input.eventType,
    providerOccurredAt: input.occurredAt ?? null,
    providerObjectRef: input.providerObjectRef ?? input.paymentLookupRef,
    paymentLookupRef: input.paymentLookupRef?.trim() || null,
    captureConfirmed: input.captureConfirmed ?? null,
    metadataOrderId: input.metadataOrderId ?? null,
    providerTotalMinor: input.providerTotalMinor ?? null,
    identityVerified: true,
    parentOrderId,
    amountMinor: input.amountMinor ?? null,
    currency: input.currency?.toUpperCase() ?? null,
    reviewReason: reason
  };
  if (existingId) {
    await tx.processedWebhookEvent.update({ where: { id: existingId }, data });
  } else {
    await tx.processedWebhookEvent.create({ data });
  }
}

async function reverseAffiliateAdjustment(tx: Tx, parentOrderId: string, adjustment: { eventId: string; eventType: string; amountMinor: number }) {
  await reverseAffiliateForOrderInTransaction(tx, parentOrderId, {
    type: adjustment.eventType === 'charge.dispute.created' || adjustment.eventType === 'CUSTOMER.DISPUTE.CREATED'
      ? AffiliateAdjustmentType.CHARGEBACK
      : AffiliateAdjustmentType.REFUND,
    eventId: adjustment.eventId,
    idempotencyKey: adjustment.eventId,
    eligibleBaseMinor: adjustment.amountMinor,
    reason: `Verified provider event ${adjustment.eventType}`
  });
}

async function supersedePendingReviews(tx: Tx, parentOrderId: string, eventId: string, reason: string) {
  const reviews = await tx.sellerCommissionReviewEvent.findMany({ where: { parentOrderId, status: 'NEEDS_ALLOCATION' }, select: { id: true } });
  if (!reviews.length) return;
  const reviewedAt = new Date();
  const resolutionReason = `${reason} Provider event ${eventId}.`.slice(0, 500);
  await tx.sellerCommissionReviewEvent.updateMany({
    where: { id: { in: reviews.map(review => review.id) }, status: 'NEEDS_ALLOCATION' },
    data: { status: 'IGNORED', reviewedAt, reviewedById: null, resolutionReason }
  });
  for (const review of reviews) {
    await tx.auditLog.create({ data: {
      actorId: null,
      action: 'SELLER_COMMISSION_REFUND_REVIEW_SUPERSEDED',
      entity: 'SellerCommissionReviewEvent',
      entityId: review.id,
      metadata: { reason: resolutionReason, providerEventId: eventId, parentOrderId }
    } });
  }
}

async function applyAdjustment(tx: Tx, event: VerifiedPaymentEvent, parentOrderId: string) {
  const provider = event.provider as PaymentMethod;
  const source = await tx.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider, eventId: event.eventId } } });
  const isRefund = refundTypes[event.provider].has(event.eventType);
  const isDispute = disputeTypes[event.provider].has(event.eventType);
  if (!isRefund && !isDispute) return null;

  let delta = source.amountMinor ?? 0;
  let cumulativeRefund = delta;
  if (isRefund && event.provider === 'STRIPE') {
    const prior = await tx.processedWebhookEvent.findMany({
      where: { provider, parentOrderId, eventType: 'charge.refunded', reviewReason: null, eventId: { not: event.eventId } },
      select: { amountMinor: true }
    });
    const priorCumulative = Math.max(0, ...prior.map(row => row.amountMinor ?? 0));
    cumulativeRefund = source.amountMinor ?? 0;
    delta = Math.max(0, cumulativeRefund - priorCumulative);
  }
  if (!amountIsValid(delta)) return null;

  let previouslyRefunded = 0;
  if (isRefund && event.provider === 'PAYPAL') {
    const prior = await tx.processedWebhookEvent.findMany({
      where: { provider, parentOrderId, eventType: 'PAYMENT.CAPTURE.REFUNDED', reviewReason: null, eventId: { not: event.eventId } },
      select: { amountMinor: true }
    });
    previouslyRefunded = prior.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0);
  }
  const full = isRefund
    ? event.provider === 'STRIPE' ? cumulativeRefund >= source.providerTotalMinor! : previouslyRefunded + delta >= (await tx.parentOrder.findUniqueOrThrow({ where: { id: parentOrderId }, select: { totalMinor: true } })).totalMinor
    : delta >= (await tx.parentOrder.findUniqueOrThrow({ where: { id: parentOrderId }, select: { totalMinor: true } })).totalMinor;
  if (full) {
    const reason = isDispute ? 'Verified full chargeback superseded pending refund allocations.' : 'Verified full refund superseded pending refund allocations.';
    await reverseSellerCommissionForOrder(tx, parentOrderId, event.eventId, isDispute ? 'Verified full chargeback.' : 'Verified full refund.');
    await supersedePendingReviews(tx, parentOrderId, event.eventId, reason);
    await tx.auditLog.create({ data: {
      actorId: null,
      action: isDispute ? 'SELLER_COMMISSION_FULL_CHARGEBACK_RECONCILED' : 'SELLER_COMMISSION_FULL_REFUND_RECONCILED',
      entity: 'ParentOrder', entityId: parentOrderId,
      metadata: { provider: event.provider, providerEventId: event.eventId, amountMinor: delta, currency: event.currency?.toUpperCase() ?? null }
    } });
    if (isRefund) {
      await tx.payment.updateMany({ where: { parentId: parentOrderId, status: { in: [PaymentStatus.PAID, PaymentStatus.DISPUTED] } }, data: { status: PaymentStatus.REFUNDED } });
    } else {
      await tx.payment.updateMany({ where: { parentId: parentOrderId, status: PaymentStatus.PAID }, data: { status: PaymentStatus.DISPUTED } });
    }
  } else {
    const reason = isDispute ? 'Verified partial chargeback requires item allocation.' : 'Verified partial refund requires item allocation.';
    const created = await createPartialRefundReview(tx, {
      parentOrderId, provider: event.provider, providerEventId: event.eventId,
      amountMinor: delta, currency: (event.currency ?? '').toUpperCase(), reason
    });
    if (created) {
      const review = await tx.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: event.provider, providerEventId: event.eventId } }, select: { id: true } });
      await tx.auditLog.create({ data: {
        actorId: null,
        action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED',
        entity: 'SellerCommissionReviewEvent', entityId: review.id,
        metadata: { provider: event.provider, providerEventId: event.eventId, parentOrderId, amountMinor: delta, currency: event.currency?.toUpperCase() ?? null }
      } });
    }
    if (isDispute) await tx.payment.updateMany({ where: { parentId: parentOrderId, status: PaymentStatus.PAID }, data: { status: PaymentStatus.DISPUTED } });
  }
  return { eventId: event.eventId, eventType: event.eventType, amountMinor: delta };
}

async function reconcileWaitingEvents(tx: Tx, provider: Provider, providerObjectRef: string, order: { id: string; totalMinor: number; currency: string }) {
  const waiting = await tx.processedWebhookEvent.findMany({
    where: { provider: provider as PaymentMethod, providerObjectRef, reviewReason: 'AWAITING_CAPTURE_ASSOCIATION' },
    orderBy: [{ providerOccurredAt: 'asc' }, { receivedAt: 'asc' }]
  });
  const adjustments: { eventId: string; eventType: string; amountMinor: number }[] = [];
  for (const row of waiting) {
    let reason: string | null = null;
    if (row.metadataOrderId && row.metadataOrderId !== order.id) reason = 'ORDER_PAYMENT_REFERENCE_MISMATCH';
    else if (row.parentOrderId && row.parentOrderId !== order.id) reason = 'ORDER_PAYMENT_REFERENCE_MISMATCH';
    else if (row.currency?.toUpperCase() !== order.currency) reason = 'PROVIDER_AMOUNT_OR_CURRENCY_REQUIRES_REVIEW';
    else if (row.eventType === 'charge.refunded' && (row.providerTotalMinor !== order.totalMinor || !amountIsValid(row.amountMinor) || row.amountMinor! > order.totalMinor)) reason = 'PROVIDER_AMOUNT_OR_CURRENCY_REQUIRES_REVIEW';
    else if (row.eventType === 'charge.dispute.created' && (!amountIsValid(row.amountMinor) || row.amountMinor! > order.totalMinor)) reason = 'PROVIDER_AMOUNT_OR_CURRENCY_REQUIRES_REVIEW';
    else if (row.eventType === 'PAYMENT.CAPTURE.REFUNDED' && (!amountIsValid(row.amountMinor) || row.amountMinor! > order.totalMinor)) reason = 'PROVIDER_AMOUNT_OR_CURRENCY_REQUIRES_REVIEW';
    else if (row.eventType === 'CUSTOMER.DISPUTE.CREATED' && (!amountIsValid(row.amountMinor) || row.amountMinor! > order.totalMinor)) reason = 'PROVIDER_AMOUNT_OR_CURRENCY_REQUIRES_REVIEW';
    else if (!refundTypes[provider].has(row.eventType ?? '') && !disputeTypes[provider].has(row.eventType ?? '')) reason = 'UNSUPPORTED_EVENT_TYPE';
    if (reason) {
      await tx.processedWebhookEvent.update({ where: { id: row.id }, data: { reviewReason: reason } });
      continue;
    }
    await tx.processedWebhookEvent.update({ where: { id: row.id }, data: { parentOrderId: order.id, reviewReason: null } });
    const result = await applyAdjustment(tx, {
      provider, eventId: row.eventId, eventType: row.eventType!, providerObjectRef,
      paymentLookupRef: providerObjectRef, metadataOrderId: row.metadataOrderId,
      amountMinor: row.amountMinor, providerTotalMinor: row.providerTotalMinor,
      currency: row.currency, occurredAt: row.providerOccurredAt
    }, order.id);
    if (result) {
      await reverseAffiliateAdjustment(tx, order.id, result);
      adjustments.push(result);
    }
  }
  return adjustments;
}

/** Process a provider-authenticated event. No provider call occurs here. */
export async function reconcileVerifiedPaymentEvent(tx: Tx, event: VerifiedPaymentEvent): Promise<WebhookReconciliationResult> {
  const lookupRef = event.paymentLookupRef?.trim() || null;
  const stableRef = event.providerObjectRef?.trim() || lookupRef;
  if (stableRef) await lockProviderReference(tx, event.provider, stableRef);
  const isCapture = captureTypes[event.provider].has(event.eventType);
  const isRefund = refundTypes[event.provider].has(event.eventType);
  const isDispute = disputeTypes[event.provider].has(event.eventType);
  const priorEvent = await tx.processedWebhookEvent.findUnique({ where: { provider_eventId: { provider: event.provider as PaymentMethod, eventId: event.eventId } } });
  const legacyUnverified = Boolean(priorEvent && !priorEvent.identityVerified);
  const replayMatches = priorEvent && (legacyUnverified
    ? matchesKnownLegacyEventFacts(event, priorEvent)
    : matchesPersistedPaymentEvent(event, priorEvent));
  if (priorEvent && !replayMatches) {
    if (!legacyUnverified) throw new Error('A replayed provider event ID did not match its persisted event identity.');
    const reason = 'LEGACY_EVENT_IDENTITY_CONFLICT';
    await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { reviewReason: reason } });
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, priorEvent.parentOrderId);
    return { orderId: priorEvent.parentOrderId, becamePaid: false, adjustments: [], reviewReason: reason };
  }
  if (priorEvent && priorEvent.identityVerified && priorEvent.reviewReason === null) {
    return { orderId: priorEvent.parentOrderId, becamePaid: false, adjustments: [], reviewReason: null };
  }

  // Stripe events can carry both a Checkout Session lookup reference and its
  // stable PaymentIntent reference. Match either only when they resolve to a
  // single local payment; conflicting local bindings are never guessed.
  const references = [...new Set([lookupRef, stableRef].filter((value): value is string => Boolean(value)))];
  const candidates = references.length ? await tx.payment.findMany({
    where: { method: event.provider as PaymentMethod, providerRef: { in: references } },
    select: { id: true, parentId: true, providerRef: true }
  }) : [];
  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
  if (uniqueCandidates.length > 1) {
    const reason = legacyUnverified ? 'LEGACY_EVENT_REQUIRES_MANUAL_REVIEW' : 'PROVIDER_REFERENCE_AMBIGUOUS';
    await storeUnresolved(tx, event, reason, null, priorEvent?.id);
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, null);
    return { orderId: null, becamePaid: false, adjustments: [], reviewReason: reason };
  }
  const payment = uniqueCandidates[0] ?? null;
  if (!payment) {
    const reason = !isCapture && !isRefund && !isDispute
      ? 'UNSUPPORTED_EVENT_TYPE'
      : stableRef
        ? 'AWAITING_CAPTURE_ASSOCIATION'
        : legacyUnverified ? 'LEGACY_EVENT_REQUIRES_MANUAL_REVIEW' : 'ORDER_PAYMENT_REFERENCE_MISMATCH';
    await storeUnresolved(tx, event, reason, null, priorEvent?.id);
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, null);
    return { orderId: null, becamePaid: false, adjustments: [], reviewReason: reason };
  }

  await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${payment.parentId} FOR UPDATE`;
  const freshPayment = await tx.payment.findUnique({ where: { id: payment.id } });
  const order = await tx.parentOrder.findUnique({ where: { id: payment.parentId }, select: {
    id: true, totalMinor: true, currency: true, status: true,
    sellerOrders: { select: { id: true, sellerId: true, status: true } }
  } });
  if (!freshPayment || !order) {
    const reason = 'ORDER_PAYMENT_REFERENCE_MISMATCH';
    await storeUnresolved(tx, event, reason, null, priorEvent?.id);
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, null);
    return { orderId: null, becamePaid: false, adjustments: [], reviewReason: reason };
  }
  const mismatched = freshPayment.method !== event.provider || (event.metadataOrderId != null && event.metadataOrderId !== order.id);
  const currencyMatches = event.currency?.toUpperCase() === order.currency;
  const commonEventData = {
    provider: event.provider as PaymentMethod, eventId: event.eventId, eventType: event.eventType,
    providerOccurredAt: event.occurredAt ?? null,
    providerObjectRef: stableRef, paymentLookupRef: lookupRef, captureConfirmed: event.captureConfirmed ?? null,
    metadataOrderId: event.metadataOrderId ?? null,
    providerTotalMinor: event.providerTotalMinor ?? null,
    identityVerified: true,
    parentOrderId: order.id, amountMinor: event.amountMinor ?? null,
    currency: event.currency?.toUpperCase() ?? null
  };
  if (mismatched) {
    if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { reviewReason: 'ORDER_PAYMENT_REFERENCE_MISMATCH' } });
    else await tx.processedWebhookEvent.create({ data: { ...commonEventData, reviewReason: 'ORDER_PAYMENT_REFERENCE_MISMATCH' } });
    if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: commonEventData });
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', 'ORDER_PAYMENT_REFERENCE_MISMATCH', order.id);
    return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: 'ORDER_PAYMENT_REFERENCE_MISMATCH' };
  }

  if (isCapture) {
    const validCapture = event.captureConfirmed === true && currencyMatches && amountIsValid(event.amountMinor) && event.amountMinor === order.totalMinor;
    const cancelledSellerOrders = order.sellerOrders.filter(sellerOrder => sellerOrder.sellerId !== null && sellerOrder.status === 'CANCELLED');
    const captureReviewReason = cancelledSellerOrders.length ? 'CAPTURE_AFTER_SELLER_CANCELLATION_REQUIRES_REVIEW' : null;
    if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { ...commonEventData, parentOrderId: order.id, reviewReason: validCapture ? captureReviewReason : 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH' } });
    else await tx.processedWebhookEvent.create({ data: { ...commonEventData, reviewReason: validCapture ? captureReviewReason : 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH' } });
    const persistedCaptureEvent = await tx.processedWebhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: event.provider as PaymentMethod, eventId: event.eventId } }, select: { id: true }
    });
    if (!validCapture) {
      const reason = event.captureConfirmed !== true ? 'PAYMENT_CAPTURE_NOT_CONFIRMED' : 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH';
      await tx.processedWebhookEvent.update({
        where: { provider_eventId: { provider: event.provider as PaymentMethod, eventId: event.eventId } },
        data: { reviewReason: reason }
      });
      await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, order.id);
      return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: reason };
    }
    const updated = await tx.payment.updateMany({ where: { id: freshPayment.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.PAID, paidAt: new Date(), providerRef: event.providerObjectRef ?? lookupRef! } });
    const currentPayment = await tx.payment.findUniqueOrThrow({ where: { id: freshPayment.id }, select: { status: true } });
    if (updated.count || currentPayment.status === PaymentStatus.PAID) {
      if (updated.count) {
        const allSellerOrdersCancelled = order.sellerOrders.length > 0 && order.sellerOrders.every(sellerOrder => sellerOrder.status === 'CANCELLED');
        await tx.parentOrder.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: allSellerOrdersCancelled ? 'CANCELLED' : 'CONFIRMED' } });
        await tx.auditLog.create({ data: {
          actorId: null,
          action: 'PAYMENT_CAPTURE_RECONCILED',
          entity: 'Payment',
          entityId: freshPayment.id,
          metadata: { provider: event.provider, providerEventId: event.eventId, parentOrderId: order.id, amountMinor: event.amountMinor, currency: order.currency }
        } });
        if (captureReviewReason) await tx.auditLog.create({ data: {
          actorId: null,
          action: 'PAYMENT_CAPTURE_AFTER_SELLER_CANCELLATION_REQUIRES_REVIEW',
          entity: 'ProcessedWebhookEvent',
          entityId: persistedCaptureEvent.id,
          metadata: { provider: event.provider, providerEventId: event.eventId, parentOrderId: order.id, cancelledSellerOrderIds: cancelledSellerOrders.map(row => row.id) }
        } });
      }
      await accrueSellerCommissionsForPaidOrder(tx, order.id, event.eventId);
      await settleAffiliateForPaidOrderInTransaction(tx, order.id, event.eventId);
      const adjustments = stableRef ? await reconcileWaitingEvents(tx, event.provider, stableRef, order) : [];
      await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', null, order.id);
      return { orderId: order.id, becamePaid: updated.count > 0, adjustments, reviewReason: captureReviewReason };
    }
    await tx.processedWebhookEvent.update({ where: { provider_eventId: { provider: event.provider as PaymentMethod, eventId: event.eventId } }, data: { reviewReason: 'PAYMENT_STATE_REQUIRES_REVIEW' } });
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', 'PAYMENT_STATE_REQUIRES_REVIEW', order.id);
    return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: 'PAYMENT_STATE_REQUIRES_REVIEW' };
  }

  if (isRefund || isDispute) {
    const amountValid = amountIsValid(event.amountMinor) && currencyMatches
      && (!isRefund || event.provider !== 'STRIPE' || event.providerTotalMinor === order.totalMinor)
      && (event.amountMinor ?? 0) <= order.totalMinor;
    if (freshPayment.status === PaymentStatus.PENDING) {
      await storeUnresolved(tx, event, 'AWAITING_CAPTURE_ASSOCIATION', order.id, priorEvent?.id);
      await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', 'AWAITING_CAPTURE_ASSOCIATION', order.id);
      return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: 'AWAITING_CAPTURE_ASSOCIATION' };
    }
    const refundableState = freshPayment.status === PaymentStatus.PAID
      || freshPayment.status === PaymentStatus.DISPUTED
      || freshPayment.status === PaymentStatus.REFUNDED;
    if (!amountValid || !refundableState) {
      if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { reviewReason: !amountValid ? 'REFUND_OR_DISPUTE_AMOUNT_REQUIRES_REVIEW' : 'PAYMENT_STATE_REQUIRES_REVIEW' } });
      else await tx.processedWebhookEvent.create({ data: { ...commonEventData, reviewReason: !amountValid ? 'REFUND_OR_DISPUTE_AMOUNT_REQUIRES_REVIEW' : 'PAYMENT_STATE_REQUIRES_REVIEW' } });
      if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: commonEventData });
      const reason = !amountValid ? 'REFUND_OR_DISPUTE_AMOUNT_REQUIRES_REVIEW' : 'PAYMENT_STATE_REQUIRES_REVIEW';
      await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', reason, order.id);
      return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: reason };
    }
    if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { ...commonEventData, parentOrderId: order.id, reviewReason: null } });
    else await tx.processedWebhookEvent.create({ data: { ...commonEventData, reviewReason: null } });
    const result = await applyAdjustment(tx, event, order.id);
    if (result) await reverseAffiliateAdjustment(tx, order.id, result);
    await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', null, order.id);
    return { orderId: order.id, becamePaid: false, adjustments: result ? [result] : [], reviewReason: null };
  }

  if (priorEvent) await tx.processedWebhookEvent.update({ where: { id: priorEvent.id }, data: { ...commonEventData, reviewReason: 'UNSUPPORTED_EVENT_TYPE' } });
  else await tx.processedWebhookEvent.create({ data: { ...commonEventData, reviewReason: 'UNSUPPORTED_EVENT_TYPE' } });
  await auditLegacyWebhook(tx, priorEvent, 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', 'UNSUPPORTED_EVENT_TYPE', order.id);
  return { orderId: order.id, becamePaid: false, adjustments: [], reviewReason: 'UNSUPPORTED_EVENT_TYPE' };
}
