import { Prisma } from '@prisma/client';
import { decimalToMinorExact } from './currency-domain.js';
import { prisma } from './security.js';
import { env } from './config.js';
import { stripe } from './payments.js';
import { calculateSponsoredClickSpend, calculateSponsoredViewSpend } from './store-buster-sponsored-domain.js';
import { effectiveStorePlan, storeEntitlements } from './store-plan-domain.js';

type Provider = 'STRIPE' | 'PAYPAL';
type JsonRecord = Record<string, unknown>;
type FundingCapture = {
  provider: Provider;
  eventId: string;
  eventType: string;
  fundingIntentId?: string | null;
  providerOrderRef?: string | null;
  providerCheckoutRef?: string | null;
  providerPaymentRef?: string | null;
  amountMinor: number | null;
  currency: string | null;
  captureConfirmed: boolean;
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function providerRef(value: unknown): string | null { return typeof value === 'string' ? value : record(value)?.id as string | undefined ?? null; }
function utcDay(value: Date) { const day = new Date(value); day.setUTCHours(0, 0, 0, 0); return day; }
function safeLedgerAmount(value: number | null) { return value != null && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null; }
function safeCurrency(value: string | null) { const normalized = value?.trim().toUpperCase() ?? ''; return /^[A-Z]{3}$/.test(normalized) ? normalized : null; }

/** Settle a provider-verified ad-balance top-up exactly once. This ledger is intentionally
 * separate from seller proceeds, buyer wallets, and order payment reconciliation. */
export async function settleStoreBusterFunding(input: FundingCapture) {
  try {
    return await prisma.$transaction(async tx => {
      const previousEvent = await tx.storeBusterFundingEvent.findUnique({ where: { provider_eventId: { provider: input.provider, eventId: input.eventId } } });
      if (previousEvent) return { handled: true, reconciliation: previousEvent.reviewReason ? 'REVIEW_REQUIRED' as const : 'DUPLICATE' as const };
      const providerReferences: Prisma.StoreBusterAdFundingIntentWhereInput[] = [];
      if (input.providerOrderRef) providerReferences.push({ providerOrderRef: input.providerOrderRef });
      if (input.providerCheckoutRef) providerReferences.push({ providerCheckoutRef: input.providerCheckoutRef });
      if (input.providerPaymentRef) providerReferences.push({ providerPaymentRef: input.providerPaymentRef });
      if (!input.fundingIntentId && !providerReferences.length) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
      const referenceMatches = providerReferences.length
        ? await tx.storeBusterAdFundingIntent.findMany({ where: { provider: input.provider, OR: providerReferences }, select: { id: true, accountId: true } })
        : [];
      const identityMatch = input.fundingIntentId
        ? await tx.storeBusterAdFundingIntent.findFirst({ where: { id: input.fundingIntentId, provider: input.provider }, select: { id: true, accountId: true } })
        : null;
      const matchedIds = [...new Set([...(identityMatch ? [identityMatch.id] : []), ...referenceMatches.map(match => match.id)])].sort();
      const intentId = identityMatch?.id ?? referenceMatches[0]?.id;
      if (!intentId) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
      const conflictingIdentity = (input.fundingIntentId != null && input.fundingIntentId !== intentId) || matchedIds.length > 1;
      // Always lock funding intents before accounts. Refund/review and admin
      // resolution paths use this same order to avoid deadlocks.
      for (const matchedId of matchedIds) {
        await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdFundingIntent" WHERE "id" = ${matchedId} FOR UPDATE`;
      }
      const accountIds = [...new Set(matchedIds.map(id => identityMatch?.id === id ? identityMatch.accountId : referenceMatches.find(match => match.id === id)?.accountId).filter((id): id is string => Boolean(id)))].sort();
      for (const accountId of accountIds) {
        await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "id" = ${accountId} FOR UPDATE`;
      }
      let intent = await tx.storeBusterAdFundingIntent.findUnique({ where: { id: intentId }, include: { account: true } });
      if (!intent) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };

      let reviewReason: string | null = null;
      if (!input.captureConfirmed) reviewReason = 'Provider event did not confirm a completed capture.';
      else if (conflictingIdentity) reviewReason = 'Funding intent identity or provider references conflict.';
      else if (input.amountMinor !== intent.amountMinor || input.currency?.toUpperCase() !== intent.currency) reviewReason = 'Captured amount or currency did not match the funding intent.';
      else if (intent.providerOrderRef && input.providerOrderRef && intent.providerOrderRef !== input.providerOrderRef) reviewReason = 'Provider order reference did not match the stored funding session.';
      else if (intent.providerCheckoutRef && input.providerCheckoutRef && intent.providerCheckoutRef !== input.providerCheckoutRef) reviewReason = 'Provider checkout reference did not match the stored funding session.';
      else if (intent.providerPaymentRef && input.providerPaymentRef && intent.providerPaymentRef !== input.providerPaymentRef) reviewReason = 'Provider payment reference did not match the stored funding session.';
      else if (providerReferences.length && await tx.storeBusterAdFundingIntent.findFirst({ where: { provider: input.provider, id: { not: intent.id }, OR: providerReferences }, select: { id: true } })) reviewReason = 'A provider reference is already associated with a different funding intent.';
      else if (intent.status !== 'PAID' && (intent.expiresAt <= new Date() || intent.status === 'EXPIRED' || intent.status === 'FAILED')) reviewReason = 'Payment arrived after the funding intent was no longer active.';
      else if (intent.status === 'REVIEW') reviewReason = 'Funding intent already requires manual reconciliation.';

      const paidCaptureMatches = intent.status === 'PAID' && !conflictingIdentity && input.captureConfirmed && input.amountMinor === intent.amountMinor && input.currency?.toUpperCase() === intent.currency
        && (!intent.providerOrderRef || !input.providerOrderRef || intent.providerOrderRef === input.providerOrderRef)
        && (!intent.providerCheckoutRef || !input.providerCheckoutRef || intent.providerCheckoutRef === input.providerCheckoutRef)
        && (!intent.providerPaymentRef || !input.providerPaymentRef || intent.providerPaymentRef === input.providerPaymentRef)
        && Boolean((intent.providerPaymentRef && input.providerPaymentRef === intent.providerPaymentRef)
          || (intent.providerCheckoutRef && input.providerCheckoutRef === intent.providerCheckoutRef)
          || (intent.providerOrderRef && input.providerOrderRef === intent.providerOrderRef));
      const paidCaptureConflict = intent.status === 'PAID' && input.captureConfirmed && !paidCaptureMatches;
      const eventReviewReason = intent.status === 'PAID' ? (paidCaptureConflict ? 'A second or conflicting captured payment was reported for an already credited funding intent.' : null) : reviewReason;

      await tx.storeBusterFundingEvent.create({ data: {
        provider: input.provider, eventId: input.eventId, eventType: input.eventType, fundingIntentId: intent.id,
        amountMinor: safeLedgerAmount(input.amountMinor),
        currency: safeCurrency(input.currency), reviewReason: eventReviewReason
      } });

      if (intent.status === 'PAID') {
        if (paidCaptureConflict) {
          await tx.storeBusterAdFundingIntent.updateMany({ where: { id: { in: matchedIds } }, data: { status: 'REVIEW' } });
          await tx.storeBusterAdAccount.updateMany({ where: { id: { in: accountIds } }, data: { status: 'FROZEN' } });
          return { handled: true, reconciliation: 'REVIEW_REQUIRED' as const };
        }
        await tx.storeBusterAdFundingIntent.update({ where: { id: intent.id }, data: {
          ...(input.providerOrderRef && !intent.providerOrderRef ? { providerOrderRef: input.providerOrderRef } : {}),
          ...(input.providerCheckoutRef && !intent.providerCheckoutRef ? { providerCheckoutRef: input.providerCheckoutRef } : {}),
          ...(input.providerPaymentRef && !intent.providerPaymentRef ? { providerPaymentRef: input.providerPaymentRef } : {})
        } });
        return { handled: true, reconciliation: 'DUPLICATE' as const };
      }
      if (reviewReason) {
        if (input.captureConfirmed) {
          for (const matchedId of matchedIds) {
            await tx.storeBusterAdFundingIntent.updateMany({ where: { id: matchedId, status: { not: 'PAID' } }, data: { status: 'REVIEW' } });
          }
          for (const accountId of accountIds) {
            await tx.storeBusterAdAccount.update({ where: { id: accountId }, data: { status: 'FROZEN' } });
          }
        }
        return { handled: true, reconciliation: 'REVIEW_REQUIRED' as const };
      }

      const balanceAfter = intent.account.availableMinor + intent.amountMinor;
      if (balanceAfter > 2_147_483_647) {
        await tx.storeBusterFundingEvent.update({ where: { provider_eventId: { provider: input.provider, eventId: input.eventId } }, data: { reviewReason: 'Ad balance would exceed the supported ledger range.' } });
        await tx.storeBusterAdFundingIntent.update({ where: { id: intent.id }, data: { status: 'REVIEW' } });
        await tx.storeBusterAdAccount.update({ where: { id: intent.accountId }, data: { status: 'FROZEN' } });
        return { handled: true, reconciliation: 'REVIEW_REQUIRED' as const };
      }
      await tx.storeBusterAdAccount.update({ where: { id: intent.accountId }, data: { availableMinor: balanceAfter } });
      await tx.storeBusterAdLedgerEntry.create({ data: {
        accountId: intent.accountId, fundingIntentId: intent.id, type: 'TOP_UP', amountMinor: intent.amountMinor,
        balanceAfterMinor: balanceAfter, currency: intent.currency, idempotencyKey: `funding:${intent.id}`
      } });
      await tx.storeBusterAdFundingIntent.update({ where: { id: intent.id }, data: {
        status: 'PAID', paidAt: new Date(),
        ...(input.providerOrderRef ? { providerOrderRef: input.providerOrderRef } : {}),
        ...(input.providerCheckoutRef ? { providerCheckoutRef: input.providerCheckoutRef } : {}),
        ...(input.providerPaymentRef ? { providerPaymentRef: input.providerPaymentRef } : {})
      } });
      return { handled: true, reconciliation: 'COMPLETE' as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.storeBusterFundingEvent.findUnique({ where: { provider_eventId: { provider: input.provider, eventId: input.eventId } } });
      if (existing) return { handled: true, reconciliation: existing.reviewReason ? 'REVIEW_REQUIRED' as const : 'DUPLICATE' as const };
    }
    throw error;
  }
}

async function freezeFundingForReview(input: { provider: Provider; eventId: string; eventType: string; fundingIntentId?: string | null; providerPaymentRef?: string | null; providerOrderRef?: string | null; amountMinor?: number | null; currency?: string | null; reason: string }) {
  return prisma.$transaction(async tx => {
    const prior = await tx.storeBusterFundingEvent.findUnique({ where: { provider_eventId: { provider: input.provider, eventId: input.eventId } } });
    if (prior) return { handled: true, reconciliation: 'DUPLICATE' as const };
    const references: Prisma.StoreBusterAdFundingIntentWhereInput[] = [];
    if (input.providerPaymentRef) references.push({ providerPaymentRef: input.providerPaymentRef });
    if (input.providerOrderRef) references.push({ providerOrderRef: input.providerOrderRef });
    const matches = references.length ? await tx.storeBusterAdFundingIntent.findMany({ where: { provider: input.provider, OR: references }, select: { id: true, accountId: true } }) : [];
    const byId = input.fundingIntentId ? await tx.storeBusterAdFundingIntent.findFirst({ where: { id: input.fundingIntentId, provider: input.provider }, select: { id: true, accountId: true } }) : null;
    const matched = [...new Map([...(byId ? [byId] : []), ...matches].map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
    if (!matched.length) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
    for (const item of matched) await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdFundingIntent" WHERE "id" = ${item.id} FOR UPDATE`;
    const accountIds = [...new Set(matched.map(item => item.accountId))].sort();
    for (const accountId of accountIds) await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "id" = ${accountId} FOR UPDATE`;
    const primary = matched[0];
    if (!primary) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
    const intent = await tx.storeBusterAdFundingIntent.findUniqueOrThrow({ where: { id: primary.id } });
    await tx.storeBusterFundingEvent.create({ data: { provider: input.provider, eventId: input.eventId, eventType: input.eventType, fundingIntentId: intent.id, amountMinor: safeLedgerAmount(input.amountMinor ?? null), currency: safeCurrency(input.currency ?? null), reviewReason: input.reason.slice(0, 500) } });
    await tx.storeBusterAdFundingIntent.updateMany({ where: { id: { in: matched.map(item => item.id) } }, data: { status: 'REVIEW' } });
    await tx.storeBusterAdAccount.updateMany({ where: { id: { in: accountIds } }, data: { status: 'FROZEN' } });
    return { handled: true, reconciliation: 'REVIEW_REQUIRED' as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Consume only the dedicated Store Buster Checkout metadata before ordinary order reconciliation. */
export async function handleSponsoredStripeEvent(eventInput: unknown) {
  const event = record(eventInput);
  const type = text(event?.type);
  const data = record(event?.data);
  const object = record(data?.object);
  const eventId = text(event?.id);
  if (!type || !object || !eventId) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
  const paymentRef = type === 'payment_intent.succeeded' ? text(object.id) : providerRef(object.payment_intent);
  if (type === 'charge.refunded' || type === 'charge.dispute.created') {
    const chargeMetadata = record(object.metadata);
    let fundingIntentId = text(chargeMetadata?.purpose) === 'STORE_BUSTER_AD_BALANCE' ? text(chargeMetadata?.fundingIntentId) : null;
    if (!fundingIntentId && paymentRef) {
      const localIntent = await prisma.storeBusterAdFundingIntent.findFirst({ where: { provider: 'STRIPE', providerPaymentRef: paymentRef }, select: { id: true } });
      fundingIntentId = localIntent?.id ?? null;
    }
    if (!fundingIntentId && paymentRef && stripe) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentRef);
        const metadata = paymentIntent.metadata as Record<string, string>;
        if (metadata.purpose === 'STORE_BUSTER_AD_BALANCE') fundingIntentId = text(metadata.fundingIntentId);
      } catch {
        // Do not block normal marketplace refund reconciliation if lookup fails.
      }
    }
    const review = await freezeFundingForReview({ provider: 'STRIPE', eventId, eventType: type, fundingIntentId, providerPaymentRef: paymentRef, amountMinor: typeof object.amount_refunded === 'number' ? object.amount_refunded : typeof object.amount === 'number' ? object.amount : null, currency: text(object.currency), reason: type === 'charge.dispute.created' ? 'Stripe payment dispute requires manual review.' : 'Stripe reported a refund for the ad-balance payment.' });
    if (review.handled) return review;
  }
  const metadata = record(object.metadata);
  const fundingIntentId = text(metadata?.fundingIntentId);
  if (text(metadata?.purpose) !== 'STORE_BUSTER_AD_BALANCE' || !fundingIntentId) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed' || type === 'payment_intent.payment_failed') {
    return prisma.$transaction(async tx => {
      const previous = await tx.storeBusterFundingEvent.findUnique({ where: { provider_eventId: { provider: 'STRIPE', eventId } } });
      if (previous) return { handled: true, reconciliation: 'DUPLICATE' as const };
      const intent = await tx.storeBusterAdFundingIntent.findFirst({ where: { id: fundingIntentId, provider: 'STRIPE' } });
      if (!intent) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
      await tx.storeBusterFundingEvent.create({ data: { provider: 'STRIPE', eventId, eventType: type, fundingIntentId: intent.id, reviewReason: null } });
      await tx.storeBusterAdFundingIntent.updateMany({ where: { id: intent.id, status: 'PENDING' }, data: { status: 'FAILED' } });
      return { handled: true, reconciliation: 'FAILED' as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  const isSession = type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded';
  const isPaymentIntent = type === 'payment_intent.succeeded';
  if (!isSession && !isPaymentIntent) return { handled: true, reconciliation: 'AWAITING_CAPTURE' as const };
  if (isSession && object.payment_status !== 'paid') return { handled: true, reconciliation: 'AWAITING_CAPTURE' as const };
  const amount = isSession ? object.amount_total : object.amount_received ?? object.amount;
  return settleStoreBusterFunding({
    provider: 'STRIPE', eventId, eventType: type, fundingIntentId,
    providerCheckoutRef: isSession ? text(object.id) : null,
    providerPaymentRef: paymentRef,
    amountMinor: typeof amount === 'number' ? amount : null,
    currency: text(object.currency)?.toUpperCase() ?? null,
    captureConfirmed: isSession ? object.payment_status === 'paid' && Boolean(text(object.id)) && Boolean(paymentRef) : object.status === 'succeeded' && Boolean(paymentRef)
  });
}

/** Handles a signature-verified PayPal top-up capture/refund event. */
export async function handleSponsoredPaypalEvent(eventInput: unknown, lookupMinorUnit: (currency: string) => Promise<number | null>) {
  const event = record(eventInput);
  const type = text(event?.event_type);
  const eventId = text(event?.id);
  const resource = record(event?.resource);
  if (!type || !eventId || !resource) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
  const supplementary = record(resource.supplementary_data);
  const relatedIds = record(supplementary?.related_ids);
  const providerOrder = text(relatedIds?.order_id);
  const captureId = text(resource.id);
  if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    const review = await freezeFundingForReview({ provider: 'PAYPAL', eventId, eventType: type, providerPaymentRef: captureId, providerOrderRef: providerOrder, reason: 'PayPal reported a refund or reversal for the ad-balance payment.' });
    if (review.handled) return review;
  }
  let fundingIntentId: string | null = null;
  let orderRef = providerOrder;
  let paymentRef = captureId;
  let amountSource: unknown = resource.amount;
  let confirmed = type === 'PAYMENT.CAPTURE.COMPLETED' && resource.status === 'COMPLETED' && Boolean(providerOrder && captureId);
  if (type === 'CHECKOUT.ORDER.COMPLETED') {
    const orderId = text(resource.id);
    const units = Array.isArray(resource.purchase_units) ? resource.purchase_units.map(record) : [];
    const unit = units.length === 1 ? units[0] : null;
    const customId = text(unit?.custom_id);
    const referenceId = text(unit?.reference_id);
    const fundingTag = customId?.startsWith('store-buster-ad:') ? customId : referenceId?.startsWith('store-buster-ad:') ? referenceId : null;
    fundingIntentId = fundingTag?.slice('store-buster-ad:'.length) ?? null;
    const payments = record(unit?.payments);
    const captures = Array.isArray(payments?.captures) ? payments.captures.map(record) : [];
    const capture = captures.length === 1 ? captures[0] : null;
    const sameRef = !customId || !referenceId || customId === referenceId;
    amountSource = capture?.amount;
    paymentRef = text(capture?.id);
    orderRef = orderId;
    confirmed = resource.status === 'COMPLETED' && capture?.status === 'COMPLETED' && Boolean(orderId && capture?.id && fundingIntentId && sameRef);
    if (!fundingIntentId) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
  } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    // Capture webhooks omit purchase-unit custom_id; the provider order reference is stored on intent creation.
    if (!orderRef) return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };
  } else return { handled: false, reconciliation: 'NOT_AD_FUNDING' as const };

  const amount = record(amountSource);
  const currency = text(amount?.currency_code)?.toUpperCase() ?? null;
  const decimal = text(amount?.value);
  let amountMinor: number | null = null;
  if (currency && decimal) {
    const exponent = await lookupMinorUnit(currency);
    if (exponent !== null) { try { amountMinor = decimalToMinorExact(decimal, exponent); } catch { amountMinor = null; } }
  }
  return settleStoreBusterFunding({ provider: 'PAYPAL', eventId, eventType: type, fundingIntentId, providerOrderRef: orderRef, providerPaymentRef: paymentRef, amountMinor, currency, captureConfirmed: confirmed });
}

export async function settleStoreBusterClick(input: { campaignId: string; impressionId: string; userId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const day = utcDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return prisma.$transaction(async tx => {
    const impression = await tx.storeBusterImpression.findFirst({ where: { id: input.impressionId, campaignId: input.campaignId, shownAt: { not: null }, clickedAt: null, expiresAt: { gt: now } }, include: { campaign: { include: { store: true } } } });
    if (!impression || !impression.productId) return { counted: false, destinationProductId: null };
    const campaign = impression.campaign;
    const settings = await tx.storeBusterSettings.findUnique({ where: { id: 'default' } });
    if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || campaign.status !== 'APPROVED' || !campaign.sponsored || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired || (campaign.endsAt && campaign.endsAt <= now) || (campaign.startsAt && campaign.startsAt > now)) return { counted: false, destinationProductId: impression.productId };
    const billingModel = campaign.billingModel ?? 'CPC';
    const clickPriceMinor = campaign.pricePerClickSnapshot ?? settings.pricePerClickMinor;
    if (billingModel === 'CPC' && clickPriceMinor <= 0) return { counted: false, destinationProductId: impression.productId };
    await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "storeId" = ${campaign.storeId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoreBusterCampaign" WHERE "id" = ${campaign.id} FOR UPDATE`;
    const account = await tx.storeBusterAdAccount.findUnique({ where: { storeId: campaign.storeId } });
    if (!account || account.status !== 'ACTIVE' || account.currency !== env.CURRENCY || account.availableMinor < (billingModel === 'CPC' ? clickPriceMinor : 0)) return { counted: false, destinationProductId: impression.productId };
    const product = await tx.product.findFirst({ where: { id: impression.productId, status: 'APPROVED', sellerId: campaign.store.sellerId, seller: { status: 'APPROVED' }, inventory: { quantity: { gt: 0 } } }, select: { id: true, categoryId: true, category: { select: { status: true } } } });
    if (!product || product.category?.status !== 'ACTIVE' || (campaign.audienceCategoryIds.length > 0 && (!product.categoryId || !campaign.audienceCategoryIds.includes(product.categoryId)))) return { counted: false, destinationProductId: impression.productId };
    const [campaignMonthSpend, campaignDailySpend, campaignLifetimeSpend, storeMonthSpend, effectivePlan] = await Promise.all([
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: campaign.id, day: { gte: monthStart } }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: campaign.id, day }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: campaign.id }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaign: { storeId: campaign.storeId, sponsored: true }, day: { gte: monthStart } }, _sum: { spendMinor: true } }),
      effectiveStorePlan(tx, campaign.storeId)
    ]);
    const entitlements = await storeEntitlements(tx, campaign.storeId, effectivePlan.version);
    if (!entitlements.storeBusterEnabled) return { counted: false, destinationProductId: impression.productId };
    const storeBudgetCap = Math.min(settings.maxMonthlyBudgetMinor, entitlements.storeBusterMonthlyBudgetMinor);
    const campaignSpentThisMonth = campaignMonthSpend._sum.spendMinor ?? 0;
    const campaignSpentLifetime = campaignLifetimeSpend._sum.spendMinor ?? 0;
    const campaignSpentToday = campaignDailySpend._sum.spendMinor ?? 0;
    if (campaign.lifetimeBudgetMinor != null && campaignSpentLifetime >= campaign.lifetimeBudgetMinor) return { counted: false, destinationProductId: impression.productId };
    if (campaign.dailyBudgetMinor != null && campaignSpentToday >= campaign.dailyBudgetMinor) return { counted: false, destinationProductId: impression.productId };
    if (billingModel === 'CPV') {
      const clickClaim = await tx.storeBusterImpression.updateMany({ where: { id: impression.id, shownAt: { not: null }, clickedAt: null, expiresAt: { gt: now } }, data: { clickedAt: now } });
      if (clickClaim.count !== 1) return { counted: false, destinationProductId: impression.productId };
      await tx.storeBusterDailyMetric.updateMany({ where: { campaignId: campaign.id, day: impression.day }, data: { clicks: { increment: 1 } } });
      return { counted: true, destinationProductId: product.id };
    }
    const spend = calculateSponsoredClickSpend({
      availableMinor: account.availableMinor,
      clickPriceMinor,
      campaignSpentThisMonthMinor: campaignSpentThisMonth,
      campaignSpentTodayMinor: campaignSpentToday,
      campaignDailyBudgetMinor: campaign.dailyBudgetMinor ?? undefined,
      campaignSpentLifetimeMinor: campaignSpentLifetime,
      campaignLifetimeBudgetMinor: campaign.lifetimeBudgetMinor ?? undefined,
      storeSpentThisMonthMinor: storeMonthSpend._sum.spendMinor ?? 0,
      campaignBudgetMinor: campaign.monthlyBudgetMinor,
      platformBudgetCapMinor: storeBudgetCap
    });
    if (!spend) return { counted: false, destinationProductId: impression.productId };
    const clickClaim = await tx.storeBusterImpression.updateMany({ where: { id: impression.id, shownAt: { not: null }, clickedAt: null, expiresAt: { gt: now } }, data: { clickedAt: now } });
    if (clickClaim.count !== 1) return { counted: false, destinationProductId: impression.productId };
    const balanceAfter = spend.balanceAfterMinor;
    await tx.storeBusterAdAccount.update({ where: { id: account.id }, data: { availableMinor: balanceAfter } });
    await tx.storeBusterAdLedgerEntry.create({ data: { accountId: account.id, campaignId: campaign.id, type: 'CLICK_SPEND', amountMinor: -spend.amountMinor, balanceAfterMinor: balanceAfter, currency: account.currency, idempotencyKey: `click:${impression.id}` } });
    await tx.storeBusterDailyMetric.upsert({ where: { campaignId_day: { campaignId: campaign.id, day: impression.day } }, create: { campaignId: campaign.id, day: impression.day, impressions: 1, clicks: 1, spendMinor: spend.amountMinor }, update: { clicks: { increment: 1 }, spendMinor: { increment: spend.amountMinor } } });
    return { counted: true, destinationProductId: product.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Counts a single user-bound, viewable impression and atomically charges CPV
 * campaigns from the separate prepaid ad balance. CPC campaigns only meter it. */
export async function settleStoreBusterImpression(input: { campaignId: string; impressionId: string; userId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const day = utcDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return prisma.$transaction(async tx => {
    const pending = await tx.storeBusterImpression.findFirst({ where: { id: input.impressionId, campaignId: input.campaignId, shownAt: null, clickedAt: null, expiresAt: { gt: now }, tokenHash: { not: '' } }, include: { campaign: true } });
    if (!pending || !pending.tokenHash) return { counted: false, chargedMinor: 0 };
    // The route verifies the user-bound token hash before calling this function.
    void input.userId;
    const campaign = pending.campaign;
    const settings = await tx.storeBusterSettings.findUnique({ where: { id: 'default' } });
    if (!env.STORE_BUSTER_SPONSORED_AVAILABLE || campaign.status !== 'APPROVED' || !campaign.sponsored || !settings?.enabled || !settings.sponsoredEnabled || !settings.moderationRequired || (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt <= now)) return { counted: false, chargedMinor: 0 };
    await tx.$queryRaw`SELECT "id" FROM "StoreBusterAdAccount" WHERE "storeId" = ${campaign.storeId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoreBusterCampaign" WHERE "id" = ${campaign.id} FOR UPDATE`;
    const [account, currentCampaign, impression] = await Promise.all([
      tx.storeBusterAdAccount.findUnique({ where: { storeId: campaign.storeId } }),
      tx.storeBusterCampaign.findUnique({ where: { id: campaign.id } }),
      tx.storeBusterImpression.findUnique({ where: { id: pending.id } })
    ]);
    if (!account || account.status !== 'ACTIVE' || account.currency !== env.CURRENCY || account.availableMinor <= 0 || !currentCampaign || !impression || impression.shownAt || impression.expiresAt <= now) return { counted: false, chargedMinor: 0 };
    const billingModel = currentCampaign.billingModel ?? 'CPC';
    const rate = currentCampaign.pricePer100ViewsSnapshot ?? settings.pricePer100ViewsMinor;
    if (billingModel === 'CPV' && rate <= 0) return { counted: false, chargedMinor: 0 };
    const [monthSpend, todaySpend, lifetimeSpend, storeSpend, effectivePlan] = await Promise.all([
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: currentCampaign.id, day: { gte: monthStart } }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: currentCampaign.id, day }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaignId: currentCampaign.id }, _sum: { spendMinor: true } }),
      tx.storeBusterDailyMetric.aggregate({ where: { campaign: { storeId: currentCampaign.storeId, sponsored: true }, day: { gte: monthStart } }, _sum: { spendMinor: true } }),
      effectiveStorePlan(tx, currentCampaign.storeId)
    ]);
    const entitlements = await storeEntitlements(tx, currentCampaign.storeId, effectivePlan.version);
    const platformMonthlyBudgetMinor = Math.min(settings.maxMonthlyBudgetMinor, entitlements.storeBusterMonthlyBudgetMinor);
    let amountMinor = 0;
    let remainderAfter = currentCampaign.viewBillingRemainder;
    if (billingModel === 'CPV') {
      if (currentCampaign.lifetimeBudgetMinor != null && (lifetimeSpend._sum.spendMinor ?? 0) >= currentCampaign.lifetimeBudgetMinor) return { counted: false, chargedMinor: 0 };
      const charge = calculateSponsoredViewSpend({
        availableMinor: account.availableMinor, pricePer100ViewsMinor: rate, billingRemainder: currentCampaign.viewBillingRemainder,
        campaignSpendMinor: monthSpend._sum.spendMinor ?? 0, dailySpendMinor: todaySpend._sum.spendMinor ?? 0,
        campaignLifetimeSpendMinor: lifetimeSpend._sum.spendMinor ?? 0, campaignLifetimeBudgetMinor: currentCampaign.lifetimeBudgetMinor ?? undefined,
        storeMonthlySpendMinor: storeSpend._sum.spendMinor ?? 0, campaignBudgetMinor: currentCampaign.monthlyBudgetMinor,
        dailyBudgetMinor: currentCampaign.dailyBudgetMinor ?? currentCampaign.monthlyBudgetMinor, platformMonthlyBudgetMinor
      });
      if (!charge) return { counted: false, chargedMinor: 0 };
      amountMinor = charge.amountMinor;
      remainderAfter = charge.remainderAfter;
    }
    const claimed = await tx.storeBusterImpression.updateMany({ where: { id: impression.id, shownAt: null, clickedAt: null, expiresAt: { gt: now } }, data: { shownAt: now } });
    if (claimed.count !== 1) return { counted: false, chargedMinor: 0 };
    await tx.storeBusterDailyMetric.upsert({ where: { campaignId_day: { campaignId: currentCampaign.id, day: impression.day } }, create: { campaignId: currentCampaign.id, day: impression.day, impressions: 1, clicks: 0, spendMinor: amountMinor }, update: { impressions: { increment: 1 }, ...(amountMinor ? { spendMinor: { increment: amountMinor } } : {}) } });
    if (billingModel === 'CPV') await tx.storeBusterCampaign.update({ where: { id: currentCampaign.id }, data: { viewBillingRemainder: remainderAfter } });
    if (amountMinor > 0) {
      const balanceAfter = account.availableMinor - amountMinor;
      await tx.storeBusterAdAccount.update({ where: { id: account.id }, data: { availableMinor: balanceAfter } });
      await tx.storeBusterAdLedgerEntry.create({ data: { accountId: account.id, campaignId: currentCampaign.id, type: 'VIEW_SPEND', amountMinor: -amountMinor, balanceAfterMinor: balanceAfter, currency: account.currency, idempotencyKey: `view:${impression.id}` } });
    }
    return { counted: true, chargedMinor: amountMinor };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

