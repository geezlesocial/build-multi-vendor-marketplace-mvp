import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { isDisposableWalletFundingDatabaseUrl } from "./wallet-safety.js";

// This suite is enabled only for CI's per-run, loopback-only database. In
// particular, a developer's ordinary marketplace database cannot pass this
// guard, even if it is named *_test or an allowlist is configured.
const databaseUrl = process.env.DATABASE_URL ?? "";
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
const isDisposableTarget = isDisposableWalletFundingDatabaseUrl(
  databaseUrl,
  sandboxId,
);
if (process.env.GITHUB_ACTIONS === "true" && !isDisposableTarget) {
  throw new Error(
    "CI requires a matching loopback-only disposable database for commission concurrency tests",
  );
}

function makeDisposableClient() {
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

const prisma = makeDisposableClient();
const fixtureSuffix = randomUUID().replaceAll("-", "");
let fixture:
  | {
      parentOrderId: string;
      sellerOrderId: string;
      productId: string;
      sellerId: string;
      userId: string;
      productTypeId: string;
    }
  | undefined;

describe.skipIf(!prisma)("seller commission PostgreSQL concurrency", () => {
  it("serializes concurrent accrual and full-reversal transactions", async () => {
    const db = prisma;
    if (!db) throw new Error("Disposable database guard unexpectedly failed");

    await db.$connect();
    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `commission-${fixtureSuffix}@example.test`,
          passwordHash: "synthetic-test-only-hash",
          name: "Synthetic Commission Test Seller",
          role: "SELLER",
          seller: { create: { status: "APPROVED" } },
        },
        include: { seller: true },
      });
      if (!user.seller)
        throw new Error("Synthetic seller fixture was not created");

      const productType = await tx.catalogProductType.create({
        data: {
          name: `Commission Test ${fixtureSuffix}`,
          slug: `commission-test-${fixtureSuffix}`,
        },
      });
      const product = await tx.product.create({
        data: {
          sellerId: user.seller.id,
          productTypeId: productType.id,
          name: "Synthetic commission product",
          slug: `commission-product-${fixtureSuffix}`,
          description: "Disposable PostgreSQL integration fixture.",
          priceMinor: 10_000,
          status: "APPROVED",
        },
      });
      const order = await tx.parentOrder.create({
        data: {
          orderNumber: `COMMISSION-${fixtureSuffix}`,
          buyerEmail: `buyer-${fixtureSuffix}@example.test`,
          buyerName: "Synthetic Integration Buyer",
          addressJson: { country: "US", synthetic: true },
          totalMinor: 10_000,
          currency: "USD",
          sellerOrders: {
            create: {
              sellerId: user.seller.id,
              status: "CONFIRMED",
              totalMinor: 10_000,
              commissionSnapshotJson: {
                version: 1,
                type: "PERCENTAGE",
                basisPoints: 1_000,
                fixedMinor: null,
                minimumMinor: null,
                capMinor: null,
                currency: "USD",
                policyVersionId: null,
              },
              items: {
                create: {
                  productId: product.id,
                  productName: product.name,
                  unitPriceMinor: 10_000,
                  quantity: 1,
                },
              },
            },
          },
          payment: {
            create: {
              method: "STRIPE",
              status: "PAID",
              paidAt: new Date(),
            },
          },
        },
        include: { sellerOrders: true },
      });
      const sellerOrder = order.sellerOrders[0];
      if (!sellerOrder)
        throw new Error("Synthetic seller order was not created");

      return {
        parentOrderId: order.id,
        sellerOrderId: sellerOrder.id,
        productId: product.id,
        sellerId: user.seller.id,
        userId: user.id,
        productTypeId: productType.id,
      };
    });
    fixture = created;

    const {
      accrueSellerCommissionsForPaidOrder,
      reverseSellerCommissionForOrder,
    } = await import("./seller-commission.js");

    const accrualResults = await Promise.all([
      db.$transaction((tx) =>
        accrueSellerCommissionsForPaidOrder(
          tx,
          created.parentOrderId,
          `synthetic-accrual-a-${fixtureSuffix}`,
        ),
      ),
      db.$transaction((tx) =>
        accrueSellerCommissionsForPaidOrder(
          tx,
          created.parentOrderId,
          `synthetic-accrual-b-${fixtureSuffix}`,
        ),
      ),
    ]);
    expect(accrualResults.reduce((sum, count) => sum + count, 0)).toBe(1);

    const accruals = await db.sellerCommissionLedgerEntry.findMany({
      where: { sellerOrderId: created.sellerOrderId, entryType: "ACCRUAL" },
    });
    expect(accruals).toHaveLength(1);
    expect(accruals[0]).toMatchObject({
      amountMinor: 1_000,
      eligibleBaseMinor: 10_000,
      currency: "USD",
      sellerId: created.sellerId,
    });

    const reversalResults = await Promise.all([
      db.$transaction((tx) =>
        reverseSellerCommissionForOrder(
          tx,
          created.parentOrderId,
          `synthetic-reversal-a-${fixtureSuffix}`,
          "Synthetic integration-test reversal",
        ),
      ),
      db.$transaction((tx) =>
        reverseSellerCommissionForOrder(
          tx,
          created.parentOrderId,
          `synthetic-reversal-b-${fixtureSuffix}`,
          "Synthetic integration-test reversal",
        ),
      ),
    ]);
    expect(reversalResults.reduce((sum, count) => sum + count, 0)).toBe(1);

    const ledger = await db.sellerCommissionLedgerEntry.findMany({
      where: { sellerOrderId: created.sellerOrderId },
      orderBy: { entryType: "asc" },
    });
    expect(ledger).toHaveLength(2);
    expect(
      ledger.filter((entry) => entry.entryType === "REVERSAL"),
    ).toMatchObject([{ amountMinor: -1_000, eligibleBaseMinor: 10_000 }]);
    expect(
      await db.$transaction((tx) =>
        reverseSellerCommissionForOrder(
          tx,
          created.parentOrderId,
          `synthetic-reversal-a-${fixtureSuffix}`,
          "Synthetic integration-test retry",
        ),
      ),
    ).toBe(0);
  });
});

afterAll(async () => {
  if (!prisma) return;
  try {
    if (fixture) {
      await prisma.$transaction(async (tx) => {
        await tx.sellerCommissionLedgerEntry.deleteMany({
          where: { sellerOrderId: fixture!.sellerOrderId },
        });
        await tx.orderItem.deleteMany({
          where: { sellerOrderId: fixture!.sellerOrderId },
        });
        await tx.sellerOrder.deleteMany({
          where: { id: fixture!.sellerOrderId },
        });
        await tx.payment.deleteMany({
          where: { parentId: fixture!.parentOrderId },
        });
        await tx.parentOrder.deleteMany({
          where: { id: fixture!.parentOrderId },
        });
        await tx.product.deleteMany({ where: { id: fixture!.productId } });
        await tx.seller.deleteMany({ where: { id: fixture!.sellerId } });
        await tx.user.deleteMany({ where: { id: fixture!.userId } });
        await tx.catalogProductType.deleteMany({
          where: { id: fixture!.productTypeId },
        });
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});
