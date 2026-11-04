import { createHash } from "node:crypto";
import {
  Prisma,
  ProductStatus,
  SeofyAuditTargetType,
  SellerStatus,
  StorePlanAssignmentSource,
  StorePlanStatus,
  StorePlanVersionStatus,
} from "@prisma/client";
import { prisma } from "./security.js";
import { effectiveStorePlan } from "./store-plan-domain.js";
import { isFreePlan } from "./store-plan-pricing.js";
import { hasActivePaidThemeSubscription } from "./store-theme-domain.js";
import type { SeofyTarget } from "./seofy-domain.js";

export const AUDIT_FRESHNESS_DAYS = 30;
export const LEARNING_RETENTION_DAYS = 90;
export const LEARNING_MIN_USERS = 20;
const AUDIT_RETENTION_DAYS = 365;

const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

export type SeofyDb = typeof prisma | Prisma.TransactionClient;
export type TargetRecord = SeofyTarget & {
  targetId: string;
  sellerId: string;
  sourceHash: string;
};

export async function approvedSellerStore(
  sellerId: string,
  db: SeofyDb = prisma,
) {
  const seller = await db.seller.findFirst({
    where: { id: sellerId, status: SellerStatus.APPROVED },
    select: {
      id: true,
      status: true,
      store: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          seoTitle: true,
          seoDescription: true,
          seofyLearningEnabled: true,
          isPlatformStore: true,
        },
      },
    },
  });
  if (!seller?.store || seller.store.isPlatformStore)
    throw fail(403, "An approved seller Store is required.");
  return { sellerId: seller.id, store: seller.store };
}

export async function activePaidSeofyEntitlement(
  db: SeofyDb,
  storeId: string,
  now = new Date(),
) {
  const effective = await effectiveStorePlan(db, storeId, now);
  const { assignment, version } = effective;
  if (
    !assignment ||
    !version ||
    assignment.source !== StorePlanAssignmentSource.SUBSCRIPTION ||
    !version.seofyEnabled ||
    isFreePlan(version) ||
    version.plan.status !== StorePlanStatus.ACTIVE ||
    version.status !== StorePlanVersionStatus.ACTIVE
  )
    return false;
  const subscription = await db.storeSubscription.findFirst({
    where: {
      storeId,
      planVersionId: version.id,
      status: "ACTIVE",
      provider: { not: null },
      providerSubscriptionId: { not: null },
      monthlyPriceMinor: { gt: 0 },
      currentPeriodStart: { lte: now },
      currentPeriodEnd: { gt: now },
      cancelledAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: now } }] },
      ],
    },
    select: {
      provider: true,
      providerSubscriptionId: true,
      status: true,
      monthlyPriceMinor: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      trialEndsAt: true,
      expiresAt: true,
      cancelledAt: true,
    },
  });
  return hasActivePaidThemeSubscription(
    {
      assignmentSource: assignment.source,
      assignmentEffectiveFrom: assignment.effectiveFrom,
      assignmentEffectiveUntil: assignment.effectiveUntil,
      planStatus: version.plan.status,
      planVersionStatus: version.status,
      versionEffectiveFrom: version.effectiveFrom,
      versionEffectiveUntil: version.effectiveUntil,
      versionMonthlyPriceMinor: version.monthlyPriceMinor,
      versionAnnualPriceMinor: version.annualPriceMinor,
      versionIntroPriceMinor: version.introPriceMinor,
      versionTrialDays: version.freeTrialDays,
      subscriptionStatus: subscription?.status ?? null,
      subscriptionProvider: subscription?.provider ?? null,
      providerSubscriptionId: subscription?.providerSubscriptionId ?? null,
      subscriptionMonthlyPriceMinor: subscription?.monthlyPriceMinor ?? 0,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      expiresAt: subscription?.expiresAt ?? null,
      cancelledAt: subscription?.cancelledAt ?? null,
    },
    now,
  );
}

function sourceHash(
  input: Omit<TargetRecord, "sourceHash" | "targetId" | "sellerId">,
) {
  const source = {
    kind: input.kind,
    name: input.name,
    storeName: input.storeName,
    description: input.description,
    categoryName: input.categoryName ?? null,
    brandName: input.brandName ?? null,
    imageCount: input.imageCount ?? null,
    missingImageAltCount: input.missingImageAltCount ?? null,
  };
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export async function targetRecord(
  db: SeofyDb,
  input: {
    kind: SeofyAuditTargetType;
    targetId?: string;
    storeId: string;
    sellerId: string;
  },
): Promise<TargetRecord | null> {
  if (input.kind === SeofyAuditTargetType.STORE) {
    const store = await db.store.findFirst({
      where: {
        id: input.storeId,
        sellerId: input.sellerId,
        isPlatformStore: false,
        seller: { status: SellerStatus.APPROVED },
      },
      select: {
        id: true,
        sellerId: true,
        name: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
      },
    });
    if (!store) return null;
    const target: SeofyTarget = {
      kind: "STORE",
      name: store.name,
      storeName: store.name,
      description: store.description ?? "",
      seoTitle: store.seoTitle,
      seoDescription: store.seoDescription,
    };
    return {
      ...target,
      targetId: store.id,
      sellerId: store.sellerId,
      sourceHash: sourceHash(target),
    };
  }
  if (!input.targetId) return null;
  const product = await db.product.findFirst({
    where: {
      id: input.targetId,
      sellerId: input.sellerId,
      status: ProductStatus.APPROVED,
      seller: { status: SellerStatus.APPROVED, store: { id: input.storeId } },
    },
    select: {
      id: true,
      sellerId: true,
      name: true,
      description: true,
      seoTitle: true,
      seoDescription: true,
      category: { select: { name: true } },
      brand: { select: { name: true } },
      images: { select: { alt: true } },
      seller: { select: { store: { select: { name: true } } } },
    },
  });
  if (!product?.sellerId) return null;
  const target: SeofyTarget = {
    kind: "PRODUCT",
    name: product.name,
    storeName: product.seller?.store?.name ?? null,
    description: product.description,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    categoryName: product.category?.name ?? null,
    brandName: product.brand?.name ?? null,
    imageCount: product.images.length,
    missingImageAltCount: product.images.filter((image) => !image.alt.trim())
      .length,
  };
  return {
    ...target,
    targetId: product.id,
    sellerId: product.sellerId,
    sourceHash: sourceHash(target),
  };
}

export async function privacySafeLearning(
  storeId: string,
  sellerId: string,
  enabled: boolean,
  db: SeofyDb = prisma,
) {
  if (!enabled)
    return [] as {
      category: string;
      signalCount: number;
      consentingUsers: number;
    }[];
  const cutoff = new Date(Date.now() - LEARNING_RETENTION_DAYS * 86_400_000);
  const rows = await db.$queryRaw<
    Array<{ category: string; signalCount: bigint; consentingUsers: bigint }>
  >`
    SELECT category."name" AS category,
           COUNT(*)::bigint AS "signalCount",
           COUNT(DISTINCT signal."userId")::bigint AS "consentingUsers"
    FROM "StoreInterestSignal" AS signal
    JOIN "Product" AS product ON product."id" = signal."productId"
    JOIN "Category" AS category ON category."id" = signal."categoryId"
    JOIN "UserPreference" AS preference ON preference."userId" = signal."userId"
    WHERE product."sellerId" = ${sellerId}
      AND product."status" = 'APPROVED'
      AND signal."createdAt" >= ${cutoff}
      AND signal."categoryId" IS NOT NULL
      AND preference."personalizationEnabled" = true
      AND preference."personalizationConsentAt" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "Store" AS store WHERE store."id" = ${storeId} AND store."sellerId" = ${sellerId})
    GROUP BY category."id", category."name"
    HAVING COUNT(DISTINCT signal."userId") >= ${LEARNING_MIN_USERS}
    ORDER BY COUNT(*) DESC
    LIMIT 8
  `;
  return rows.map((row) => ({
    category: row.category,
    signalCount: Number(row.signalCount),
    consentingUsers: Number(row.consentingUsers),
  }));
}

export async function auditTargetForSeller(
  sellerId: string,
  storeId: string,
  kind: SeofyAuditTargetType,
  targetId?: string,
) {
  const target = await targetRecord(prisma, {
    kind,
    targetId,
    storeId,
    sellerId,
  });
  if (!target)
    throw Object.assign(
      new Error(
        kind === SeofyAuditTargetType.PRODUCT
          ? "Approved product not found in your Store."
          : "Store not found.",
      ),
      { statusCode: 404 },
    );
  return target;
}

export async function purgeExpiredSeofyAudits(now = new Date()) {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
  const result = await prisma.seofyAudit.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}
