import { Prisma, StorePlanAssignmentStatus, StoreSubscriptionEventStatus, StoreSubscriptionInvoiceStatus, StoreSubscriptionStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from './security.js';

type JsonRecord = Record<string, unknown>;
type Db = typeof prisma;
const GRACE_PERIOD_DAYS = 7;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}
function text(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null; }
function integer(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null; }
function providerId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return text(record(value)?.id);
}
function unixDate(value: unknown): Date | null {
  const seconds = integer(value);
  return seconds !== null && seconds > 0 ? new Date(seconds * 1000) : null;
}
function metadataId(object: JsonRecord) {
  const metadata = record(object.metadata);
  return text(metadata?.storeSubscriptionId) ?? text(object.client_reference_id);
}
function eventObject(event: Stripe.Event) { return record(event.data.object) ?? {}; }
function safeCode(error: unknown) {
  return error instanceof SubscriptionBillingError ? error.code : 'PROCESSING_FAILED';
}

export class SubscriptionBillingError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function requireValue<T>(value: T | null | undefined, code: string, message: string): T {
  if (value === null || value === undefined) throw new SubscriptionBillingError(code, message);
  return value;
}

async function lockSubscription(tx: Prisma.TransactionClient, subscriptionId: string) {
  const peek = await tx.storeSubscription.findUnique({ where: { id: subscriptionId }, select: { storeId: true } });
  if (!peek) throw new SubscriptionBillingError('SUBSCRIPTION_NOT_FOUND', 'The local subscription could not be matched.');
  // All subscription mutations lock Store first, then subscription, so Store
  // entitlement assignments serialize with cancellation and webhook updates.
  await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${peek.storeId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "StoreSubscription" WHERE "id" = ${subscriptionId} FOR UPDATE`;
  const subscription = await tx.storeSubscription.findUnique({
    where: { id: subscriptionId },
    include: { planVersion: { include: { plan: true } }, store: { include: { seller: true } } }
  });
  if (!subscription) throw new SubscriptionBillingError('SUBSCRIPTION_NOT_FOUND', 'The local subscription could not be matched.');
  return subscription;
}

async function findSubscription(tx: Prisma.TransactionClient, object: JsonRecord, stripeSubscriptionId?: string | null) {
  const localId = metadataId(object);
  if (localId) {
    const candidate = await tx.storeSubscription.findUnique({ where: { id: localId }, select: { id: true } });
    if (candidate) return candidate.id;
  }
  if (stripeSubscriptionId) {
    const candidate = await tx.storeSubscription.findFirst({ where: { provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId }, select: { id: true } });
    if (candidate) return candidate.id;
  }
  return null;
}

async function auditTransition(tx: Prisma.TransactionClient, subscriptionId: string, action: string, metadata: Prisma.InputJsonObject) {
  await tx.auditLog.create({ data: { actorId: null, action, entity: 'StoreSubscription', entityId: subscriptionId, metadata } });
}

async function assignSubscriptionPlan(tx: Prisma.TransactionClient, subscription: Awaited<ReturnType<typeof lockSubscription>>, now: Date) {
  const current = await tx.storePlanAssignment.findFirst({
    where: { storeId: subscription.storeId, status: StorePlanAssignmentStatus.ACTIVE, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }]
  });
  if (current?.planVersionId === subscription.planVersionId) return;
  const effectiveFrom = new Date(Math.max(now.getTime(), (current?.effectiveFrom.getTime() ?? 0) + 1));
  if (current) await tx.storePlanAssignment.update({ where: { id: current.id }, data: { status: StorePlanAssignmentStatus.SUPERSEDED, effectiveUntil: effectiveFrom } });
  await tx.storePlanAssignment.updateMany({ where: { storeId: subscription.storeId, status: StorePlanAssignmentStatus.ACTIVE, effectiveUntil: { lte: effectiveFrom } }, data: { status: StorePlanAssignmentStatus.EXPIRED } });
  const assignment = await tx.storePlanAssignment.create({
    data: { storeId: subscription.storeId, planVersionId: subscription.planVersionId, status: StorePlanAssignmentStatus.ACTIVE, source: 'SUBSCRIPTION', effectiveFrom, reason: `Verified Stripe subscription ${subscription.id}` }
  });
  await tx.auditLog.create({
    data: {
      actorId: null, action: 'STORE_PLAN_SUBSCRIPTION_ASSIGNED', entity: 'Store', entityId: subscription.storeId,
      metadata: { subscriptionId: subscription.id, assignmentId: assignment.id, planVersionId: subscription.planVersionId, provider: 'STRIPE' }
    }
  });
}

async function expireSubscriptionEntitlements(tx: Prisma.TransactionClient, subscription: Awaited<ReturnType<typeof lockSubscription>>, now: Date) {
  const active = await tx.storePlanAssignment.findFirst({ where: { storeId: subscription.storeId, planVersionId: subscription.planVersionId, status: StorePlanAssignmentStatus.ACTIVE }, orderBy: { effectiveFrom: 'desc' } });
  if (active) await tx.storePlanAssignment.update({ where: { id: active.id }, data: { status: StorePlanAssignmentStatus.EXPIRED, effectiveUntil: now } });
  if (subscription.expirationBehavior === 'DOWNGRADE_TO_LEGACY') {
    const legacy = await tx.storePlanVersion.findFirst({ where: { plan: { key: 'legacy-compatible', status: 'ACTIVE' }, status: 'ACTIVE' }, select: { id: true } });
    if (legacy) {
      const existingLegacy = await tx.storePlanAssignment.findFirst({ where: { storeId: subscription.storeId, planVersionId: legacy.id, status: StorePlanAssignmentStatus.ACTIVE, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, select: { id: true } });
      if (!existingLegacy) await tx.storePlanAssignment.create({ data: { storeId: subscription.storeId, planVersionId: legacy.id, status: StorePlanAssignmentStatus.ACTIVE, source: 'SUBSCRIPTION', effectiveFrom: now, reason: `Subscription ${subscription.id} ended; restored compatibility plan` } });
    }
  } else if (subscription.store.seller.status === 'APPROVED') {
    await tx.seller.update({ where: { id: subscription.store.seller.id }, data: { status: 'SUSPENDED', reason: `Store plan subscription ${subscription.id} expired` } });
  }
}

function expectedAmount(subscription: Awaited<ReturnType<typeof lockSubscription>>) {
  return subscription.interval === 'ANNUAL' ? subscription.annualPriceMinor : subscription.monthlyPriceMinor;
}

async function applyEvent(tx: Prisma.TransactionClient, event: Stripe.Event) {
  const object = eventObject(event);
  const objectId = requireValue(text(object.id), 'EVENT_OBJECT_ID_MISSING', 'The provider event object has no identity.');
  const now = new Date(event.created * 1000);

  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') throw new SubscriptionBillingError('CHECKOUT_MODE_MISMATCH', 'The Checkout session is not a subscription.');
    const subscriptionId = requireValue(await findSubscription(tx, object, providerId(object.subscription)), 'SUBSCRIPTION_NOT_FOUND', 'The checkout event could not be matched to a local subscription.');
    const subscription = await lockSubscription(tx, subscriptionId);
    const metadata = record(object.metadata);
    if (text(metadata?.storeId) !== subscription.storeId || text(metadata?.planVersion) !== String(subscription.planVersion.version)) {
      throw new SubscriptionBillingError('CHECKOUT_METADATA_MISMATCH', 'The checkout metadata does not match the saved Store plan terms.');
    }
    const stripeSubscriptionId = providerId(object.subscription);
    if (subscription.providerSubscriptionId && stripeSubscriptionId && subscription.providerSubscriptionId !== stripeSubscriptionId) throw new SubscriptionBillingError('PROVIDER_REFERENCE_MISMATCH', 'The provider subscription reference changed unexpectedly.');
    await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerCheckoutSessionId: objectId, ...(stripeSubscriptionId ? { providerSubscriptionId: stripeSubscriptionId } : {}) } });
    await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_CHECKOUT_LINKED', { eventId: event.id, checkoutSessionId: objectId, providerSubscriptionId: stripeSubscriptionId });
    return 'APPLIED' as const;
  }

  if (event.type === 'checkout.session.expired') {
    const subscriptionId = requireValue(await findSubscription(tx, object), 'SUBSCRIPTION_NOT_FOUND', 'The expired checkout could not be matched to a local subscription.');
    const subscription = await lockSubscription(tx, subscriptionId);
    const metadata = record(object.metadata);
    if (text(metadata?.storeId) !== subscription.storeId) throw new SubscriptionBillingError('CHECKOUT_METADATA_MISMATCH', 'The checkout metadata does not match the Store.');
    if (subscription.status === StoreSubscriptionStatus.PENDING) {
      await tx.storeSubscription.update({ where: { id: subscription.id }, data: { providerCheckoutSessionId: objectId, status: StoreSubscriptionStatus.CANCELLED, cancelledAt: now, expiresAt: now } });
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_CHECKOUT_EXPIRED', { eventId: event.id, checkoutSessionId: objectId });
    }
    return 'APPLIED' as const;
  }

  if (event.type.startsWith('customer.subscription.')) {
    const stripeSubscriptionId = requireValue(text(object.id), 'PROVIDER_REFERENCE_MISSING', 'The provider subscription has no identity.');
    const subscriptionId = requireValue(await findSubscription(tx, object, stripeSubscriptionId), 'SUBSCRIPTION_NOT_FOUND', 'The provider subscription could not be matched to a local subscription.');
    const subscription = await lockSubscription(tx, subscriptionId);
    if (subscription.providerSubscriptionId && subscription.providerSubscriptionId !== stripeSubscriptionId) throw new SubscriptionBillingError('PROVIDER_REFERENCE_MISMATCH', 'The provider subscription reference does not match the saved subscription.');
    const metadata = record(object.metadata);
    if (metadata && text(metadata.storeId) !== subscription.storeId) throw new SubscriptionBillingError('STORE_SCOPE_MISMATCH', 'The provider event Store metadata does not match.');
    const status = text(object.status);
    const periodStart = unixDate(object.current_period_start);
    const periodEnd = unixDate(object.current_period_end);
    const trialEnd = unixDate(object.trial_end);
    const cancelAtPeriodEnd = object.cancel_at_period_end === true;
    if (event.type === 'customer.subscription.deleted' || status === 'canceled') {
      const end = periodEnd && periodEnd > now && cancelAtPeriodEnd ? periodEnd : now;
      const updated = await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId, status: StoreSubscriptionStatus.CANCELLED, cancelAtPeriodEnd, cancelledAt: now, expiresAt: end, currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd } });
      if (end <= now) await expireSubscriptionEntitlements(tx, { ...subscription, expiresAt: end }, now);
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_CANCELLED', { eventId: event.id, expiresAt: end.toISOString(), cancelAtPeriodEnd: updated.cancelAtPeriodEnd });
      return 'APPLIED' as const;
    }
    if (status === 'trialing') {
      if (subscription.freeTrialDays <= 0 || !trialEnd) throw new SubscriptionBillingError('UNEXPECTED_TRIAL', 'The provider trial does not match the saved plan terms.');
      const providerCreatedAt = unixDate(object.created);
      if (!providerCreatedAt) throw new SubscriptionBillingError('SUBSCRIPTION_CREATED_AT_MISSING', 'The provider subscription creation time is missing.');
      const expectedTrialEnd = new Date(providerCreatedAt.getTime() + subscription.freeTrialDays * 86_400_000);
      if (Math.abs(trialEnd.getTime() - expectedTrialEnd.getTime()) > 5 * 60_000) throw new SubscriptionBillingError('TRIAL_TERM_MISMATCH', 'The provider trial duration does not match the saved plan terms.');
      if (subscription.status === StoreSubscriptionStatus.CANCELLED || subscription.status === StoreSubscriptionStatus.EXPIRED) {
        await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_TRIAL_IGNORED', { eventId: event.id, stateUnchanged: true, reason: 'TERMINAL_SUBSCRIPTION_STATE' });
        return 'APPLIED' as const;
      }
      const trialStarted = subscription.status !== StoreSubscriptionStatus.TRIALING || subscription.trialEndsAt?.getTime() !== trialEnd.getTime();
      await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId, status: StoreSubscriptionStatus.TRIALING, trialEndsAt: trialEnd, nextChargeAt: trialEnd, currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd, cancelAtPeriodEnd, expiresAt: cancelAtPeriodEnd ? periodEnd ?? trialEnd : null } });
      await assignSubscriptionPlan(tx, subscription, now);
      if (trialStarted) await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_TRIAL_STARTED', { eventId: event.id, trialEndsAt: trialEnd.toISOString(), planVersionId: subscription.planVersionId });
      return 'APPLIED' as const;
    }
    if (status === 'past_due' || status === 'unpaid') {
      const terminal = subscription.status === StoreSubscriptionStatus.CANCELLED || subscription.status === StoreSubscriptionStatus.EXPIRED;
      const wasDelinquent = subscription.status === StoreSubscriptionStatus.PAST_DUE || subscription.status === StoreSubscriptionStatus.UNPAID;
      const expiresAt = terminal ? subscription.expiresAt : subscription.expiresAt && wasDelinquent ? subscription.expiresAt : new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000);
      if (terminal) {
        await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_PAST_DUE', { eventId: event.id, stateUnchanged: true, reason: 'TERMINAL_SUBSCRIPTION_STATE' });
        return 'APPLIED' as const;
      }
      const nextStatus = status === 'unpaid' ? StoreSubscriptionStatus.UNPAID : StoreSubscriptionStatus.PAST_DUE;
      await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId, status: nextStatus, expiresAt, currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd, cancelAtPeriodEnd } });
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_PAST_DUE', { eventId: event.id, expiresAt: expiresAt?.toISOString() ?? null, gracePeriodDays: GRACE_PERIOD_DAYS });
      return 'APPLIED' as const;
    }
    if (status === 'active') {
      await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId, ...(subscription.status === StoreSubscriptionStatus.ACTIVE ? { currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd, nextChargeAt: periodEnd ?? subscription.nextChargeAt, cancelAtPeriodEnd, expiresAt: cancelAtPeriodEnd ? periodEnd : null } : {}) } });
      return 'APPLIED' as const;
    }
    // An active provider object alone is not proof the first invoice was paid.
    return 'IGNORED' as const;
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const parent = record(object.parent);
    const subscriptionDetails = record(parent?.subscription_details);
    const stripeSubscriptionId = providerId(object.subscription) ?? providerId(subscriptionDetails?.subscription);
    const subscriptionId = requireValue(await findSubscription(tx, object, stripeSubscriptionId), 'SUBSCRIPTION_NOT_FOUND', 'The invoice could not be matched to a local subscription.');
    const subscription = await lockSubscription(tx, subscriptionId);
    if (subscription.providerSubscriptionId && stripeSubscriptionId && subscription.providerSubscriptionId !== stripeSubscriptionId) throw new SubscriptionBillingError('PROVIDER_REFERENCE_MISMATCH', 'The invoice subscription reference does not match.');
    const invoiceId = objectId;
    const currency = text(object.currency)?.toUpperCase();
    if (!currency || currency !== subscription.currency) throw new SubscriptionBillingError('INVOICE_CURRENCY_MISMATCH', 'The invoice currency does not match the agreed subscription terms.');
    const amount = event.type === 'invoice.paid' ? integer(object.amount_paid) : integer(object.amount_due);
    if (amount === null || amount < 0) throw new SubscriptionBillingError('INVOICE_AMOUNT_INVALID', 'The invoice amount is missing or invalid.');
    const existingInvoice = await tx.storeSubscriptionInvoice.findFirst({ where: { provider: 'STRIPE', providerInvoiceId: invoiceId } });
    if (existingInvoice && existingInvoice.subscriptionId !== subscription.id) throw new SubscriptionBillingError('INVOICE_SCOPE_MISMATCH', 'The invoice is already attached to another Store subscription.');
    const periodStart = unixDate(object.period_start);
    const periodEnd = unixDate(object.period_end);
    if (event.type === 'invoice.payment_failed') {
      if (amount !== expectedAmount(subscription)) throw new SubscriptionBillingError('INVOICE_AMOUNT_MISMATCH', 'The failed invoice amount does not match the immutable subscription price.');
      // Stripe may deliver an earlier failure after an invoice was paid, voided,
      // or refunded. Do not move a terminal invoice state backwards.
      if (existingInvoice && (
        existingInvoice.status === StoreSubscriptionInvoiceStatus.PAID
        || existingInvoice.status === StoreSubscriptionInvoiceStatus.VOID
        || existingInvoice.status === StoreSubscriptionInvoiceStatus.REFUNDED
        || existingInvoice.status === StoreSubscriptionInvoiceStatus.PARTIALLY_REFUNDED
      )) return 'APPLIED' as const;
      const expiresAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 86_400_000);
      await tx.storeSubscriptionInvoice.upsert({
        where: { idempotencyKey: `stripe-invoice-${invoiceId}` },
        create: { subscriptionId: subscription.id, provider: 'STRIPE', providerInvoiceId: invoiceId, idempotencyKey: `stripe-invoice-${invoiceId}`, status: StoreSubscriptionInvoiceStatus.FAILED, amountMinor: amount, currency, periodStart, periodEnd, dueAt: unixDate(object.due_date) },
        update: { status: StoreSubscriptionInvoiceStatus.FAILED, amountMinor: amount, currency, periodStart, periodEnd, dueAt: unixDate(object.due_date) }
      });
      if (periodStart && subscription.currentPeriodStart && periodStart < subscription.currentPeriodStart) {
        await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_PAYMENT_FAILED', { eventId: event.id, invoiceId, amountMinor: amount, currency, stateUnchanged: true, reason: 'STALE_INVOICE_PERIOD' });
        return 'APPLIED' as const;
      }
      const terminal = subscription.status === StoreSubscriptionStatus.CANCELLED || subscription.status === StoreSubscriptionStatus.EXPIRED;
      const wasDelinquent = subscription.status === StoreSubscriptionStatus.PAST_DUE || subscription.status === StoreSubscriptionStatus.UNPAID;
      const graceExpiresAt = subscription.expiresAt && wasDelinquent
        ? subscription.expiresAt
        : expiresAt;
      if (!terminal) await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', ...(stripeSubscriptionId ? { providerSubscriptionId: stripeSubscriptionId } : {}), status: StoreSubscriptionStatus.PAST_DUE, expiresAt: graceExpiresAt, currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd } });
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_PAYMENT_FAILED', { eventId: event.id, invoiceId, amountMinor: amount, currency, gracePeriodDays: GRACE_PERIOD_DAYS, stateUnchanged: terminal, expiresAt: terminal ? subscription.expiresAt?.toISOString() ?? null : graceExpiresAt.toISOString() });
      return 'APPLIED' as const;
    }
    const trialZeroInvoice = subscription.status === StoreSubscriptionStatus.TRIALING && amount === 0;
    if (!trialZeroInvoice && amount !== expectedAmount(subscription)) throw new SubscriptionBillingError('INVOICE_AMOUNT_MISMATCH', 'The paid invoice amount does not match the immutable subscription price.');
    const paidStatus = existingInvoice && existingInvoice.refundedMinor > 0
      ? (existingInvoice.refundedMinor >= amount ? StoreSubscriptionInvoiceStatus.REFUNDED : StoreSubscriptionInvoiceStatus.PARTIALLY_REFUNDED)
      : StoreSubscriptionInvoiceStatus.PAID;
    await tx.storeSubscriptionInvoice.upsert({
      where: { idempotencyKey: `stripe-invoice-${invoiceId}` },
      create: { subscriptionId: subscription.id, provider: 'STRIPE', providerInvoiceId: invoiceId, idempotencyKey: `stripe-invoice-${invoiceId}`, status: StoreSubscriptionInvoiceStatus.PAID, amountMinor: amount, currency, periodStart, periodEnd, paidAt: now },
      update: { status: paidStatus, amountMinor: amount, currency, periodStart, periodEnd, paidAt: existingInvoice?.paidAt ?? now }
    });
    if (trialZeroInvoice) {
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_TRIAL_INVOICE_PAID', { eventId: event.id, invoiceId, amountMinor: 0, currency });
      return 'APPLIED' as const;
    }
    if (periodStart && subscription.currentPeriodStart && periodStart < subscription.currentPeriodStart) {
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_INVOICE_PAID', { eventId: event.id, invoiceId, amountMinor: amount, currency, stateUnchanged: true, reason: 'STALE_INVOICE_PERIOD' });
      return 'APPLIED' as const;
    }
    if (subscription.status === StoreSubscriptionStatus.CANCELLED || subscription.status === StoreSubscriptionStatus.EXPIRED) {
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_INVOICE_PAID', { eventId: event.id, invoiceId, amountMinor: amount, currency, stateUnchanged: true, reason: 'TERMINAL_SUBSCRIPTION_STATE' });
      return 'APPLIED' as const;
    }
    const wasActive = subscription.status === StoreSubscriptionStatus.ACTIVE;
    await tx.storeSubscription.update({ where: { id: subscription.id }, data: { provider: 'STRIPE', ...(stripeSubscriptionId ? { providerSubscriptionId: stripeSubscriptionId } : {}), status: StoreSubscriptionStatus.ACTIVE, currentPeriodStart: periodStart ?? subscription.currentPeriodStart, currentPeriodEnd: periodEnd ?? subscription.currentPeriodEnd, nextChargeAt: periodEnd ?? subscription.nextChargeAt, expiresAt: null } });
    if (!wasActive) await assignSubscriptionPlan(tx, subscription, now);
    await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_INVOICE_PAID', { eventId: event.id, invoiceId, amountMinor: amount, currency });
    return 'APPLIED' as const;
  }

  if (event.type === 'charge.refunded') {
    const invoiceId = providerId(object.invoice);
    if (!invoiceId) throw new SubscriptionBillingError('REFUND_INVOICE_MISSING', 'The refund is not linked to a subscription invoice.');
    const invoice = await tx.storeSubscriptionInvoice.findFirst({ where: { provider: 'STRIPE', providerInvoiceId: invoiceId }, include: { subscription: true } });
    if (!invoice) throw new SubscriptionBillingError('SUBSCRIPTION_INVOICE_NOT_FOUND', 'The refunded subscription invoice could not be matched.');
    await lockSubscription(tx, invoice.subscriptionId);
    const refundedMinor = integer(object.amount_refunded);
    const currency = text(object.currency)?.toUpperCase();
    if (refundedMinor === null || refundedMinor < 0 || refundedMinor > invoice.amountMinor || currency !== invoice.currency) throw new SubscriptionBillingError('REFUND_AMOUNT_INVALID', 'The refund amount or currency does not match the recorded invoice.');
    // Stripe refund events report a cumulative amount. Delayed snapshots must
    // never reduce the durable refunded total or roll invoice status back.
    if (refundedMinor <= invoice.refundedMinor) return 'APPLIED' as const;
    const status = refundedMinor === 0 ? invoice.status : refundedMinor === invoice.amountMinor ? StoreSubscriptionInvoiceStatus.REFUNDED : StoreSubscriptionInvoiceStatus.PARTIALLY_REFUNDED;
    await tx.storeSubscriptionInvoice.update({ where: { id: invoice.id }, data: { refundedMinor, status } });
    await auditTransition(tx, invoice.subscriptionId, 'STORE_SUBSCRIPTION_REFUND_RECORDED', { eventId: event.id, invoiceId, refundedMinor, currency });
    return 'APPLIED' as const;
  }

  return 'IGNORED' as const;
}

export async function processStripeStoreBillingEvent(db: Db, event: Stripe.Event) {
  const object = eventObject(event);
  const objectId = text(object.id);
  const safeSummary: Prisma.InputJsonObject = { objectId, provider: 'STRIPE' };
  let inboxEvent = await db.storeSubscriptionEvent.findUnique({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: event.id } } });
  if (!inboxEvent) {
    try {
      inboxEvent = await db.storeSubscriptionEvent.create({ data: { provider: 'STRIPE', providerEventId: event.id, eventType: event.type, status: StoreSubscriptionEventStatus.RECEIVED, signatureVerified: true, safeSummary } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      inboxEvent = await db.storeSubscriptionEvent.findUnique({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: event.id } } });
      if (!inboxEvent) throw error;
    }
  }
  const previousSummary = record(inboxEvent.safeSummary);
  if (inboxEvent.eventType !== event.type || text(previousSummary?.objectId) !== objectId) throw new SubscriptionBillingError('EVENT_IDENTITY_MISMATCH', 'A provider event identity was replayed with different event content.');

  try {
    return await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "StoreSubscriptionEvent" WHERE "id" = ${inboxEvent!.id} FOR UPDATE`;
      const currentEvent = await tx.storeSubscriptionEvent.findUniqueOrThrow({ where: { id: inboxEvent!.id } });
      if (currentEvent.status === StoreSubscriptionEventStatus.APPLIED || currentEvent.status === StoreSubscriptionEventStatus.IGNORED) return { duplicate: true, reconciliation: currentEvent.status };
      await tx.storeSubscriptionEvent.update({ where: { id: currentEvent.id }, data: { status: StoreSubscriptionEventStatus.RECEIVED, errorCode: null, processedAt: null } });
      const result = await applyEvent(tx, event);
      const linked = await tx.storeSubscription.findFirst({
        where: {
          OR: [
            { providerCheckoutSessionId: objectId },
            { providerSubscriptionId: objectId },
            { invoices: { some: { providerInvoiceId: objectId } } },
            ...(metadataId(object) ? [{ id: metadataId(object)! }] : [])
          ]
        },
        select: { id: true }
      });
      await tx.storeSubscriptionEvent.update({ where: { id: currentEvent.id }, data: { status: result === 'APPLIED' ? StoreSubscriptionEventStatus.APPLIED : StoreSubscriptionEventStatus.IGNORED, subscriptionId: linked?.id ?? null, processedAt: new Date(), errorCode: null } });
      return { duplicate: false, reconciliation: result };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    const code = safeCode(error);
    await db.storeSubscriptionEvent.updateMany({ where: { id: inboxEvent.id, status: StoreSubscriptionEventStatus.RECEIVED }, data: { status: StoreSubscriptionEventStatus.FAILED, errorCode: code, processedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
}

export async function expireDueStoreSubscriptions(db: Db, now = new Date()) {
  const candidates = await db.storeSubscription.findMany({
    where: {
      expiresAt: { lte: now },
      OR: [
        { status: StoreSubscriptionStatus.PAST_DUE },
        { status: StoreSubscriptionStatus.UNPAID },
        { status: StoreSubscriptionStatus.CANCELLED },
        { status: StoreSubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true },
        { status: StoreSubscriptionStatus.TRIALING, cancelAtPeriodEnd: true }
      ]
    },
    select: { id: true }
  });
  let expired = 0;
  for (const candidate of candidates) {
    const changed = await db.$transaction(async tx => {
      const peek = await tx.storeSubscription.findUnique({ where: { id: candidate.id }, select: { storeId: true } });
      if (!peek) return false;
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${peek.storeId} FOR UPDATE`;
      const subscription = await lockSubscription(tx, candidate.id);
      if (!subscription.expiresAt || subscription.expiresAt > now) return false;
      const expirableStatuses: StoreSubscriptionStatus[] = [StoreSubscriptionStatus.PAST_DUE, StoreSubscriptionStatus.UNPAID, StoreSubscriptionStatus.CANCELLED, StoreSubscriptionStatus.ACTIVE, StoreSubscriptionStatus.TRIALING];
      if (!expirableStatuses.includes(subscription.status)) return false;
      if (subscription.status !== StoreSubscriptionStatus.EXPIRED) await tx.storeSubscription.update({ where: { id: subscription.id }, data: { status: StoreSubscriptionStatus.EXPIRED } });
      await expireSubscriptionEntitlements(tx, subscription, now);
      await auditTransition(tx, subscription.id, 'STORE_SUBSCRIPTION_EXPIRED', { expirationBehavior: subscription.expirationBehavior, expiredAt: now.toISOString() });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (changed) expired += 1;
  }
  return expired;
}

export async function requestStoreSubscriptionCancellation(db: Db, provider: { cancelSubscription: (providerSubscriptionId: string, immediately: boolean, idempotencyKey: string) => Promise<{ currentPeriodEnd: Date | null }> }, input: { subscriptionId: string; storeId: string; actorId: string }) {
  const peek = await db.storeSubscription.findUnique({ where: { id: input.subscriptionId } });
  if (!peek || peek.storeId !== input.storeId) throw new SubscriptionBillingError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found for this Store.');
  if (!['ACTIVE', 'TRIALING', 'PAST_DUE', 'UNPAID'].includes(peek.status)) throw new SubscriptionBillingError('CANCELLATION_NOT_ALLOWED', 'This subscription cannot be cancelled in its current state.');
  if (peek.provider !== 'STRIPE' || !peek.providerSubscriptionId) throw new SubscriptionBillingError('PROVIDER_REFERENCE_MISSING', 'The subscription provider reference is not available yet.');
  const immediately = peek.cancellationPolicy === 'CANCEL_ANYTIME';
  // Do not hold database locks during a provider request. The provider call is
  // idempotent; the database transaction rechecks state before recording it.
  const result = await provider.cancelSubscription(peek.providerSubscriptionId, immediately, `store-subscription-cancel-${peek.id}-${immediately ? 'now' : 'period-end'}`);
  if (!immediately && !result.currentPeriodEnd) throw new SubscriptionBillingError('PERIOD_END_MISSING', 'Stripe did not return the current billing period end.');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${input.storeId} FOR UPDATE`;
    const subscription = await lockSubscription(tx, input.subscriptionId);
    if (!['ACTIVE', 'TRIALING', 'PAST_DUE', 'UNPAID'].includes(subscription.status)) throw new SubscriptionBillingError('CANCELLATION_NOT_ALLOWED', 'This subscription cannot be cancelled in its current state.');
    if (subscription.providerSubscriptionId !== peek.providerSubscriptionId || subscription.cancellationPolicy !== peek.cancellationPolicy) throw new SubscriptionBillingError('SUBSCRIPTION_CHANGED', 'The subscription changed while cancellation was being confirmed.');
    const now = new Date();
    const expiresAt = immediately ? now : result.currentPeriodEnd!;
    const updated = await tx.storeSubscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: !immediately, ...(immediately ? { status: StoreSubscriptionStatus.CANCELLED, cancelledAt: now } : {}), expiresAt }
    });
    if (immediately) await expireSubscriptionEntitlements(tx, subscription, now);
    await tx.auditLog.create({ data: { actorId: input.actorId, action: 'STORE_SUBSCRIPTION_CANCELLATION_REQUESTED', entity: 'StoreSubscription', entityId: subscription.id, metadata: { cancelAtPeriodEnd: !immediately, expiresAt: expiresAt.toISOString() } } });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
