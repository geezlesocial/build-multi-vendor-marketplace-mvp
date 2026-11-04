import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { isDisposableWalletFundingDatabaseUrl } from "./wallet-safety.js";
import {
  activePaidSeofyEntitlement,
  privacySafeLearning,
  targetRecord,
} from "./seofy-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
const isDisposableTarget = isDisposableWalletFundingDatabaseUrl(
  databaseUrl,
  sandboxId,
);
if (sandboxId && !isDisposableTarget)
  throw new Error(
    "SEO-FY integration tests require the matching loopback disposable database.",
  );

function createDisposableClient() {
  if (!isDisposableTarget) return null;
  const connectionUrl = new URL(databaseUrl);
  connectionUrl.searchParams.delete("schema");
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: connectionUrl.toString(),
      options: "-c search_path=public",
    }),
  });
}

const prisma = createDisposableClient();
const suffix = randomUUID().replaceAll("-", "");
const productTypeSlug = "physical-product";

describe.skipIf(!prisma)("SEO-FY PostgreSQL integration", () => {
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("enforces persisted paid entitlement, tenant scope, and consented aggregate-only learning", async () => {
    const db = prisma;
    if (!db) throw new Error("Disposable database guard unexpectedly failed.");
    await db.$connect();

    const now = new Date();
    const start = new Date(now.getTime() - 60_000);
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    const category = await db.category.create({
      data: {
        name: `SEO-FY integration ${suffix}`,
        slug: `seofy-integration-${suffix}`,
      },
    });
    const productType = await db.catalogProductType.findUniqueOrThrow({
      where: { slug: productTypeSlug },
    });
    const owner = await db.user.create({
      data: {
        email: `seofy-owner-${suffix}@example.test`,
        name: "Synthetic SEO-FY owner",
        role: "SELLER",
        passwordHash: "synthetic-integration-only-hash",
        onboardingCompletedAt: now,
        seller: {
          create: {
            status: "APPROVED",
            store: {
              create: {
                name: "Synthetic SEO-FY Store",
                slug: `seofy-store-${suffix}`,
              },
            },
          },
        },
      },
      include: { seller: { include: { store: true } } },
    });
    const foreignOwner = await db.user.create({
      data: {
        email: `seofy-foreign-${suffix}@example.test`,
        name: "Synthetic SEO-FY foreign owner",
        role: "SELLER",
        passwordHash: "synthetic-integration-only-hash",
        seller: {
          create: {
            status: "APPROVED",
            store: {
              create: {
                name: "Synthetic Foreign Store",
                slug: `seofy-foreign-store-${suffix}`,
              },
            },
          },
        },
      },
      include: { seller: { include: { store: true } } },
    });
    const ownerSeller = owner.seller;
    const ownerStore = ownerSeller?.store;
    const foreignSeller = foreignOwner.seller;
    const foreignStore = foreignSeller?.store;
    if (!ownerSeller || !ownerStore || !foreignSeller || !foreignStore)
      throw new Error("Synthetic SEO-FY seller fixtures were not created.");

    const product = await db.product.create({
      data: {
        sellerId: ownerSeller.id,
        productTypeId: productType.id,
        categoryId: category.id,
        name: "Synthetic ceramic mug",
        slug: `seofy-product-${suffix}`,
        description:
          "A handmade ceramic mug with a glazed finish and comfortable handle, designed for everyday coffee and tea. The product description remains ordinary public catalogue content for isolated SEO-FY integration testing.",
        priceMinor: 2500,
        status: "APPROVED",
        inventory: { create: { quantity: 7 } },
      },
    });
    const foreignProduct = await db.product.create({
      data: {
        sellerId: foreignSeller.id,
        productTypeId: productType.id,
        categoryId: category.id,
        name: "Foreign synthetic product",
        slug: `seofy-foreign-product-${suffix}`,
        description:
          "A foreign Store product used only for tenant-boundary testing.",
        priceMinor: 3700,
        status: "APPROVED",
      },
    });
    const plan = await db.storePlan.create({
      data: {
        key: `seofy-integration-${suffix}`,
        name: "Synthetic SEO-FY paid plan",
        status: "ACTIVE",
      },
    });
    const version = await db.storePlanVersion.create({
      data: {
        planId: plan.id,
        version: 1,
        status: "ACTIVE",
        name: "Synthetic SEO-FY paid version",
        monthlyPriceMinor: 2500,
        effectiveFrom: start,
        activatedAt: now,
        productLimit: 20,
        storeLimit: 1,
        vendorLimit: 1,
        staffSeatLimit: 2,
        seofyEnabled: true,
      },
    });
    await db.storePlanAssignment.create({
      data: {
        storeId: ownerStore.id,
        planVersionId: version.id,
        status: "ACTIVE",
        source: "SUBSCRIPTION",
        effectiveFrom: start,
      },
    });
    await db.storeSubscription.create({
      data: {
        storeId: ownerStore.id,
        planVersionId: version.id,
        provider: "STRIPE",
        providerSubscriptionId: `seofy-synthetic-${suffix}`,
        status: "ACTIVE",
        interval: "MONTHLY",
        currency: "USD",
        monthlyPriceMinor: 2500,
        freeTrialDays: 0,
        expirationBehavior: "DOWNGRADE_TO_LEGACY",
        cancellationPolicy: "CANCEL_ANYTIME",
        termsSnapshot: { syntheticFixture: true, providerContacted: false },
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });

    expect(await activePaidSeofyEntitlement(db, ownerStore.id, now)).toBe(true);
    expect(await activePaidSeofyEntitlement(db, foreignStore.id, now)).toBe(
      false,
    );
    const foreignTarget = await targetRecord(db, {
      kind: "PRODUCT",
      targetId: foreignProduct.id,
      sellerId: ownerSeller.id,
      storeId: ownerStore.id,
    });
    expect(foreignTarget).toBeNull();

    const staleStart = new Date(now.getTime() - 91 * 24 * 60 * 60_000);
    const consenting = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        db.user.create({
          data: {
            email: `seofy-consenting-${index}-${suffix}@example.test`,
            name: `Synthetic consenting buyer ${index}`,
            role: "BUYER",
            passwordHash: "synthetic-integration-only-hash",
            preference: {
              create: {
                personalizationEnabled: true,
                personalizationConsentAt: now,
              },
            },
          },
          select: { id: true },
        }),
      ),
    );
    const optedOut = await db.user.create({
      data: {
        email: `seofy-opted-out-${suffix}@example.test`,
        name: "Synthetic opted-out buyer",
        role: "BUYER",
        passwordHash: "synthetic-integration-only-hash",
        preference: {
          create: {
            personalizationEnabled: false,
            personalizationConsentAt: null,
          },
        },
      },
      select: { id: true },
    });
    await db.storeInterestSignal.createMany({
      data: [
        ...consenting.map((user) => ({
          userId: user.id,
          productId: product.id,
          categoryId: category.id,
          type: "PRODUCT_VIEW" as const,
          createdAt: now,
        })),
        {
          userId: optedOut.id,
          productId: product.id,
          categoryId: category.id,
          type: "PRODUCT_VIEW",
          createdAt: now,
        },
        {
          userId: consenting[0]!.id,
          productId: product.id,
          categoryId: category.id,
          type: "PRODUCT_VIEW",
          createdAt: staleStart,
        },
      ],
    });

    const aggregates = await privacySafeLearning(
      ownerStore.id,
      ownerSeller.id,
      true,
      db,
    );
    expect(aggregates).toEqual([
      { category: category.name, signalCount: 20, consentingUsers: 20 },
    ]);
    expect(Object.keys(aggregates[0] ?? {}).sort()).toEqual([
      "category",
      "consentingUsers",
      "signalCount",
    ]);
    expect(
      await privacySafeLearning(ownerStore.id, ownerSeller.id, false, db),
    ).toEqual([]);

    const productAfter = await db.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { inventory: true },
    });
    expect(productAfter).toMatchObject({
      seoTitle: null,
      seoDescription: null,
      priceMinor: 2500,
      status: "APPROVED",
      inventory: { quantity: 7 },
    });
  });
});
