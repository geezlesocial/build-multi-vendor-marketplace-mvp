import { Prisma, StoreEmailCampaignStatus, StoreEmailDeliveryStatus, StoreEmailSubscriberStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma } from './security.js';
import { createUnsubscribeToken } from './store-email-domain.js';
import { accountVerificationEmailStatus, sendStoreEmailCampaign, sendTransactionalNotificationEmail, StoreEmailTransportError, storeEmailProviderStatus, transactionalEmailMessageId } from './store-email-delivery.js';
import { renderTransactionalNotification, transactionalNotificationPayloadSchema, transactionalRetryDelayMs } from './transactional-email-domain.js';

const maxAttempts = 3;
const maxBatchSize = 10;
const campaignContent = z.array(z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000).refine(value => !/[<>]/.test(value)) }).strict()).min(1).max(30);
const campaignSubject = z.string().trim().min(2).max(160).refine(value => !/[\r\n]/.test(value));

async function finishIfDrained(tx: Prisma.TransactionClient, campaignId: string, now: Date) {
  const remaining = await tx.storeEmailDelivery.count({ where: { campaignId, status: { in: [StoreEmailDeliveryStatus.PENDING, StoreEmailDeliveryStatus.SENDING] } } });
  if (remaining) return;
  const campaign = await tx.storeEmailCampaign.findUnique({ where: { id: campaignId }, select: { status: true, failedCount: true } });
  if (!campaign || campaign.status !== StoreEmailCampaignStatus.QUEUED) return;
  await tx.storeEmailCampaign.update({ where: { id: campaignId }, data: { status: campaign.failedCount ? StoreEmailCampaignStatus.FAILED : StoreEmailCampaignStatus.SENT, sentAt: now } });
}

async function recoverStaleClaims(now: Date) {
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const stale = await prisma.storeEmailDelivery.findMany({ where: { status: StoreEmailDeliveryStatus.SENDING, claimedAt: { lt: staleBefore } }, select: { id: true, campaignId: true, attempts: true }, take: 100 });
  for (const delivery of stale) {
    await prisma.$transaction(async tx => {
      const exhausted = delivery.attempts >= maxAttempts;
      const changed = await tx.storeEmailDelivery.updateMany({ where: { id: delivery.id, status: StoreEmailDeliveryStatus.SENDING, claimedAt: { lt: staleBefore } }, data: { status: exhausted ? StoreEmailDeliveryStatus.FAILED : StoreEmailDeliveryStatus.PENDING, claimedAt: null, nextAttemptAt: now, lastErrorCode: exhausted ? 'DELIVERY_INTERRUPTED' : null } });
      if (changed.count && exhausted) await tx.storeEmailCampaign.update({ where: { id: delivery.campaignId }, data: { failedCount: { increment: 1 } } });
      if (changed.count) await finishIfDrained(tx, delivery.campaignId, now);
    });
  }
}

async function claimDelivery(now: Date) {
  return prisma.$transaction(async tx => {
    const candidate = await tx.storeEmailDelivery.findFirst({
      where: { status: StoreEmailDeliveryStatus.PENDING, nextAttemptAt: { lte: now }, campaign: { status: StoreEmailCampaignStatus.QUEUED } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }], select: { id: true }
    });
    if (!candidate) return null;
    const claimed = await tx.storeEmailDelivery.updateMany({ where: { id: candidate.id, status: StoreEmailDeliveryStatus.PENDING }, data: { status: StoreEmailDeliveryStatus.SENDING, claimedAt: now, attempts: { increment: 1 } } });
    return claimed.count === 1 ? candidate.id : null;
  });
}

async function processOne(deliveryId: string, now: Date) {
  const delivery = await prisma.storeEmailDelivery.findUnique({ where: { id: deliveryId }, include: { subscriber: true, campaign: { include: { store: { select: { id: true, name: true } } } } } });
  if (!delivery || delivery.status !== StoreEmailDeliveryStatus.SENDING) return;
  if (delivery.campaign.status !== StoreEmailCampaignStatus.QUEUED || delivery.subscriber.status !== StoreEmailSubscriberStatus.SUBSCRIBED || !delivery.subscriber.consentRecordedAt) {
    await prisma.$transaction(async tx => {
      await tx.storeEmailDelivery.updateMany({ where: { id: delivery.id, status: StoreEmailDeliveryStatus.SENDING }, data: { status: StoreEmailDeliveryStatus.SKIPPED, claimedAt: null } });
      await finishIfDrained(tx, delivery.campaignId, now);
    });
    return;
  }
  const content = campaignContent.parse(delivery.campaign.contentJson);
  const subject = campaignSubject.parse(delivery.campaign.subject);
  try {
    await sendStoreEmailCampaign({
      to: delivery.subscriber.email,
      storeId: delivery.campaign.store.id,
      storeName: delivery.campaign.store.name,
      subject,
      content,
      unsubscribeToken: createUnsubscribeToken(delivery.subscriberId, env.STORE_EMAIL_TOKEN_SECRET!),
      deliveryId: delivery.id
    });
    await prisma.$transaction(async tx => {
      const updated = await tx.storeEmailDelivery.updateMany({ where: { id: delivery.id, status: StoreEmailDeliveryStatus.SENDING }, data: { status: StoreEmailDeliveryStatus.SENT, sentAt: now, claimedAt: null, lastErrorCode: null } });
      if (updated.count) await tx.storeEmailCampaign.update({ where: { id: delivery.campaignId }, data: { sentCount: { increment: 1 } } });
      await finishIfDrained(tx, delivery.campaignId, now);
    });
  } catch (error) {
    const permanent = error instanceof StoreEmailTransportError && (error.code === 'EMAIL_AUTH_FAILED' || error.code === 'EMAIL_PROVIDER_NOT_CONFIGURED');
    const exhausted = permanent || delivery.attempts >= maxAttempts;
    const attemptDelayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, delivery.attempts - 1));
    const safeCode = error instanceof StoreEmailTransportError ? error.code : 'EMAIL_CONTENT_INVALID';
    await prisma.$transaction(async tx => {
      const updated = await tx.storeEmailDelivery.updateMany({ where: { id: delivery.id, status: StoreEmailDeliveryStatus.SENDING }, data: {
        status: exhausted ? StoreEmailDeliveryStatus.FAILED : StoreEmailDeliveryStatus.PENDING,
        claimedAt: null,
        nextAttemptAt: exhausted ? now : new Date(now.getTime() + attemptDelayMs),
        lastErrorCode: safeCode
      } });
      if (updated.count && exhausted) await tx.storeEmailCampaign.update({ where: { id: delivery.campaignId }, data: { failedCount: { increment: 1 } } });
      await finishIfDrained(tx, delivery.campaignId, now);
    });
  }
}

let running = false;

export async function processStoreEmailDeliveryBatch(now = new Date()) {
  if (running || !env.STORE_EMAIL_DELIVERY_AVAILABLE || !env.STORE_EMAIL_TOKEN_SECRET) return 0;
  const [platformProvider, sellerProviderCount] = await Promise.all([
    storeEmailProviderStatus(),
    prisma.storeEmailProviderConfiguration.count({ where: { active: true, verifiedAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } } })
  ]);
  if (!platformProvider.enabled && !sellerProviderCount) return 0;
  running = true;
  try {
    await recoverStaleClaims(now);
    let processed = 0;
    for (let index = 0; index < maxBatchSize; index += 1) {
      const deliveryId = await claimDelivery(now);
      if (!deliveryId) break;
      await processOne(deliveryId, now);
      processed += 1;
    }
    return processed;
  } finally { running = false; }
}

const transactionalMaxAttempts = 5;
const transactionalBatchSize = 10;
const transactionalTemplateKey = 'MARKETPLACE_NOTIFICATION_V1';
let transactionalRunning = false;

async function recoverStaleTransactionalClaims(now: Date) {
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  await prisma.$executeRaw`
    UPDATE "EmailOutbox"
    SET "status" = CASE WHEN "attempts" >= ${transactionalMaxAttempts}
      THEN 'FAILED'::"NotificationDeliveryStatus" ELSE 'PENDING'::"NotificationDeliveryStatus" END,
      "claimedAt" = NULL,
      "nextAttemptAt" = ${now},
      "lastError" = CASE WHEN "attempts" >= ${transactionalMaxAttempts} THEN 'DELIVERY_INTERRUPTED' ELSE NULL END
    WHERE "status" = 'SENDING'::"NotificationDeliveryStatus" AND "claimedAt" < ${staleBefore}`;
}

async function claimTransactionalEmail(now: Date) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH candidate AS (
        SELECT "id" FROM "EmailOutbox"
        WHERE "status" = 'PENDING'::"NotificationDeliveryStatus" AND "nextAttemptAt" <= ${now}
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "EmailOutbox" AS outbox
      SET "status" = 'SENDING'::"NotificationDeliveryStatus", "attempts" = outbox."attempts" + 1, "claimedAt" = ${now}
      FROM candidate WHERE outbox."id" = candidate."id"
      RETURNING outbox."id"`;
    return rows[0]?.id ?? null;
  });
}

async function processTransactionalEmail(outboxId: string, now: Date) {
  const outbox = await prisma.emailOutbox.findUnique({ where: { id: outboxId }, include: { recipientUser: { select: { id: true, email: true, name: true, emailVerifiedAt: true, accountStatus: true } } } });
  if (!outbox || (outbox.status as string) !== 'SENDING') return;
  const payloadResult = outbox.templateKey === transactionalTemplateKey
    ? transactionalNotificationPayloadSchema.safeParse(outbox.payloadJson)
    : null;
  if (!payloadResult?.success) {
    await prisma.$executeRaw`UPDATE "EmailOutbox" SET "status" = 'FAILED'::"NotificationDeliveryStatus", "claimedAt" = NULL, "lastError" = 'EMAIL_CONTENT_INVALID' WHERE "id" = ${outbox.id} AND "status" = 'SENDING'::"NotificationDeliveryStatus"`;
    return;
  }
  const payload = payloadResult.data;
  const recipient = outbox.recipientUser;
  const preference = recipient ? await prisma.notificationPreference.findUnique({ where: { userId_channel_category: { userId: recipient.id, channel: 'EMAIL', category: payload.category } }, select: { enabled: true } }) : null;
  if (!recipient || recipient.email !== outbox.recipientEmail || !recipient.emailVerifiedAt || recipient.accountStatus !== 'ACTIVE' || preference?.enabled === false) {
    await prisma.$executeRaw`UPDATE "EmailOutbox" SET "status" = 'SUPPRESSED'::"NotificationDeliveryStatus", "claimedAt" = NULL, "lastError" = 'RECIPIENT_NOT_ELIGIBLE' WHERE "id" = ${outbox.id} AND "status" = 'SENDING'::"NotificationDeliveryStatus"`;
    return;
  }
  const rendered = renderTransactionalNotification(payload, env.WEB_ORIGIN);
  try {
    const sent = await sendTransactionalNotificationEmail({
      to: outbox.recipientEmail,
      ...rendered,
      messageId: await transactionalEmailMessageId(outbox.id)
    });
    await prisma.$executeRaw`UPDATE "EmailOutbox" SET "status" = 'SENT'::"NotificationDeliveryStatus", "claimedAt" = NULL, "providerMessageId" = ${sent.messageId}, "lastError" = NULL WHERE "id" = ${outbox.id} AND "status" = 'SENDING'::"NotificationDeliveryStatus"`;
  } catch (error) {
    const safeCode = error instanceof StoreEmailTransportError ? error.code : 'EMAIL_DELIVERY_FAILED';
    const permanent = error instanceof StoreEmailTransportError && (error.code === 'EMAIL_AUTH_FAILED' || error.code === 'EMAIL_PROVIDER_NOT_CONFIGURED');
    const exhausted = permanent || outbox.attempts >= transactionalMaxAttempts;
    await prisma.$executeRaw`UPDATE "EmailOutbox" SET "status" = ${exhausted ? 'FAILED' : 'PENDING'}::"NotificationDeliveryStatus", "claimedAt" = NULL, "nextAttemptAt" = ${exhausted ? now : new Date(now.getTime() + transactionalRetryDelayMs(outbox.attempts))}, "lastError" = ${safeCode} WHERE "id" = ${outbox.id} AND "status" = 'SENDING'::"NotificationDeliveryStatus"`;
  }
}

/** Process durable order/support notifications; this is intentionally independent of marketing consent and gates. */
export async function processTransactionalEmailOutboxBatch(now = new Date()) {
  if (transactionalRunning || !(await accountVerificationEmailStatus()).available) return 0;
  transactionalRunning = true;
  try {
    await recoverStaleTransactionalClaims(now);
    let processed = 0;
    for (let index = 0; index < transactionalBatchSize; index += 1) {
      const id = await claimTransactionalEmail(now);
      if (!id) break;
      await processTransactionalEmail(id, now);
      processed += 1;
    }
    return processed;
  } finally { transactionalRunning = false; }
}
