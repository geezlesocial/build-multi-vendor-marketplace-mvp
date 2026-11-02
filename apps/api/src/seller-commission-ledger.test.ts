import {
  Prisma,
  SellerCommissionEntryType,
  type PaymentMethod,
  type PaymentStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({ env: { CURRENCY: "USD" } }));
vi.mock("./store-plan-domain.js", () => ({ effectiveStorePlan: vi.fn() }));

import {
  allocatePartialRefund,
  accrueSellerCommissionsForPaidOrder,
  reverseSellerCommissionForOrder,
} from "./seller-commission.js";

type LedgerRow = {
  id: string;
  sellerId: string;
  sellerOrderId: string;
  orderItemId: string;
  policyVersionId: string | null;
  entryType: SellerCommissionEntryType;
  amountMinor: number;
  eligibleBaseMinor: number;
  currency: string;
  idempotencyKey: string;
  sourceEventId: string;
  reversalOfId: string | null;
  reason?: string;
};

type OrderFixture = {
  id: string;
  currency: string;
  payment: { method: PaymentMethod; status: PaymentStatus };
  sellerOrders: Array<{
    id: string;
    sellerId: string | null;
    status: string;
    commissionSnapshotJson: Prisma.JsonValue | null;
    items: Array<{
      id: string;
      unitPriceMinor: number;
      quantity: number;
      discountMinor: number;
    }>;
  }>;
};

function paidOrder(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: "order_synthetic_commission_1",
    currency: "USD",
    payment: {
      method: "STRIPE" as PaymentMethod,
      status: "PAID" as PaymentStatus,
    },
    sellerOrders: [
      {
        id: "seller_order_synthetic_1",
        sellerId: "seller_synthetic_1",
        status: "CONFIRMED",
        commissionSnapshotJson: {
          type: "PERCENTAGE",
          fixedMinor: null,
          basisPoints: 1000,
          minimumMinor: null,
          capMinor: null,
          policyVersionId: "commission_policy_synthetic_1",
        },
        items: [
          {
            id: "item_synthetic_1",
            unitPriceMinor: 6000,
            quantity: 1,
            discountMinor: 0,
          },
          {
            id: "item_synthetic_2",
            unitPriceMinor: 4000,
            quantity: 1,
            discountMinor: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function createTransaction(order: OrderFixture) {
  const ledger: LedgerRow[] = [];
  const accruals: LedgerRow[] = [];
  const parentOrderQuery = vi.fn(async () => [{ id: order.id }]);
  const createMany = vi.fn(
    async ({ data }: { data: LedgerRow[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (ledger.some((saved) => saved.idempotencyKey === row.idempotencyKey))
          continue;
        const saved = { ...row, id: `ledger_${ledger.length + 1}` };
        ledger.push(saved);
        count += 1;
      }
      return { count };
    },
  );
  const tx = {
    $queryRaw: parentOrderQuery,
    parentOrder: { findUnique: vi.fn(async () => order) },
    sellerCommissionLedgerEntry: {
      createMany,
      findMany: vi.fn(async () => accruals),
      aggregate: vi.fn(
        async ({ where }: { where: { reversalOfId: string } }) => {
          const reversals = ledger.filter(
            (row) => row.reversalOfId === where.reversalOfId,
          );
          return {
            _sum: {
              amountMinor: reversals.reduce(
                (sum, row) => sum + row.amountMinor,
                0,
              ),
              eligibleBaseMinor: reversals.reduce(
                (sum, row) => sum + row.eligibleBaseMinor,
                0,
              ),
            },
          };
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          ledger.find((row) => row.idempotencyKey === where.idempotencyKey) ??
          null,
      ),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    calls: tx,
    ledger,
    accruals,
  };
}

function createRefundTransaction(options: { accrual?: LedgerRow | null } = {}) {
  const parentOrderId = "order_synthetic_refund_1";
  const review = {
    id: "refund_review_synthetic_1",
    parentOrderId,
    provider: "STRIPE",
    providerEventId: "evt_synthetic_refund_1",
    amountMinor: 3000,
    currency: "USD",
    status: "NEEDS_ALLOCATION",
  };
  const accrual =
    options.accrual === undefined
      ? {
          id: "ledger_accrual_refund_1",
          sellerId: "seller_synthetic_1",
          sellerOrderId: "seller_order_refund_1",
          orderItemId: "item_refund_synthetic_1",
          policyVersionId: "commission_policy_synthetic_1",
          entryType: SellerCommissionEntryType.ACCRUAL,
          amountMinor: 1000,
          eligibleBaseMinor: 10000,
          currency: "USD",
          idempotencyKey: "seller-commission:accrual:refund:1",
          sourceEventId: "evt_synthetic_capture_refund_1",
          reversalOfId: null,
        }
      : options.accrual;
  const item = {
    id: "item_refund_synthetic_1",
    unitPriceMinor: 10000,
    quantity: 1,
    discountMinor: 0,
    sellerOrder: {
      id: "seller_order_refund_1",
      sellerId: "seller_synthetic_1",
      commissionSnapshotJson: {
        type: "PERCENTAGE",
        fixedMinor: null,
        basisPoints: 1000,
        minimumMinor: null,
        capMinor: null,
      },
      items: [
        {
          id: "item_refund_synthetic_1",
          unitPriceMinor: 10000,
          quantity: 1,
          discountMinor: 0,
        },
      ],
    },
  };
  const reversals: LedgerRow[] = [];
  const createMany = vi.fn(async ({ data }: { data: LedgerRow[] }) => {
    reversals.push(...data);
    return { count: data.length };
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: parentOrderId }]),
    sellerCommissionReviewEvent: {
      findFirst: vi.fn(async () => review),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    payment: {
      findUnique: vi.fn(async () => ({
        method: "STRIPE" as PaymentMethod,
        status: "PAID" as PaymentStatus,
        paidAt: new Date("2026-10-29T12:34:56.000Z"),
      })),
    },
    parentOrder: {
      findUnique: vi.fn(async () => ({ currency: "USD", totalMinor: 10000 })),
    },
    processedWebhookEvent: {
      findFirst: vi.fn(async () => ({
        eventType: "charge.refunded",
        amountMinor: 3000,
        currency: "USD",
        normalizedAmountMinor: null,
        normalizedCurrency: null,
        providerTotalMinor: 10000,
      })),
    },
    orderItem: { findMany: vi.fn(async () => [item]) },
    sellerCommissionLedgerEntry: {
      createMany,
      findFirst: vi.fn(async () => accrual),
      aggregate: vi.fn(async () => ({
        _sum: { amountMinor: 0, eligibleBaseMinor: 0 },
      })),
      findUnique: vi.fn(async () => null),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    calls: tx,
    reversals,
    review,
  };
}

describe("seller commission ledger accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accrues a paid card order once using the immutable snapshot and item allocations", async () => {
    const fixture = paidOrder();
    const harness = createTransaction(fixture);

    const posted = await accrueSellerCommissionsForPaidOrder(
      harness.tx,
      fixture.id,
      "evt_synthetic_capture_1",
    );
    const replayed = await accrueSellerCommissionsForPaidOrder(
      harness.tx,
      fixture.id,
      "evt_synthetic_capture_1",
    );

    expect(posted).toBe(2);
    expect(replayed).toBe(0);
    expect(harness.ledger).toEqual([
      expect.objectContaining({
        entryType: SellerCommissionEntryType.ACCRUAL,
        orderItemId: "item_synthetic_1",
        amountMinor: 600,
        eligibleBaseMinor: 6000,
        idempotencyKey: `seller-commission:accrual:${fixture.id}:item_synthetic_1`,
        sourceEventId: "evt_synthetic_capture_1",
      }),
      expect.objectContaining({
        entryType: SellerCommissionEntryType.ACCRUAL,
        orderItemId: "item_synthetic_2",
        amountMinor: 400,
        eligibleBaseMinor: 4000,
      }),
    ]);
    expect(
      harness.calls.sellerCommissionLedgerEntry.createMany,
    ).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it("does not accrue COD commission before every seller order is fulfilled", async () => {
    const fixture = paidOrder({
      payment: {
        method: "COD" as PaymentMethod,
        status: "PAID" as PaymentStatus,
      },
      sellerOrders: paidOrder().sellerOrders.map((sellerOrder) => ({
        ...sellerOrder,
        status: "PROCESSING",
      })),
    });
    const harness = createTransaction(fixture);

    const posted = await accrueSellerCommissionsForPaidOrder(
      harness.tx,
      fixture.id,
      "evt_synthetic_cod_1",
    );

    expect(posted).toBe(0);
    expect(
      harness.calls.sellerCommissionLedgerEntry.createMany,
    ).not.toHaveBeenCalled();
  });

  it("reverses only the un-reversed remainder and refuses an over-reversed source", async () => {
    const fixture = paidOrder();
    const harness = createTransaction(fixture);
    const accrual: LedgerRow = {
      id: "ledger_accrual_1",
      sellerId: "seller_synthetic_1",
      sellerOrderId: "seller_order_synthetic_1",
      orderItemId: "item_synthetic_1",
      policyVersionId: "commission_policy_synthetic_1",
      entryType: SellerCommissionEntryType.ACCRUAL,
      amountMinor: 1000,
      eligibleBaseMinor: 10000,
      currency: "USD",
      idempotencyKey: "seller-commission:accrual:order:1",
      sourceEventId: "evt_capture_1",
      reversalOfId: null,
    };
    harness.accruals.push(accrual);
    harness.ledger.push({
      ...accrual,
      id: "ledger_partial_reversal_1",
      entryType: SellerCommissionEntryType.REVERSAL,
      amountMinor: -250,
      eligibleBaseMinor: 2500,
      idempotencyKey: "seller-commission:partial:review:1",
      sourceEventId: "evt_refund_partial_1",
      reversalOfId: accrual.id,
    });

    const reversed = await reverseSellerCommissionForOrder(
      harness.tx,
      fixture.id,
      "evt_refund_final_1",
      "Synthetic full-refund fixture",
    );

    expect(reversed).toBe(1);
    expect(harness.ledger.at(-1)).toMatchObject({
      entryType: SellerCommissionEntryType.REVERSAL,
      amountMinor: -750,
      eligibleBaseMinor: 7500,
      reversalOfId: accrual.id,
    });

    harness.ledger.push({
      ...accrual,
      id: "ledger_invalid_over_reversal",
      entryType: SellerCommissionEntryType.REVERSAL,
      amountMinor: -1001,
      eligibleBaseMinor: 10000,
      idempotencyKey: "seller-commission:invalid-over-reversal",
      sourceEventId: "evt_invalid_1",
      reversalOfId: accrual.id,
    });

    await expect(
      reverseSellerCommissionForOrder(
        harness.tx,
        fixture.id,
        "evt_refund_after_over_reversal",
        "Synthetic over-reversal fixture",
      ),
    ).rejects.toThrow(
      "Existing commission reversals exceed their source accrual",
    );
  });

  it("allocates a verified partial refund and reverses commission proportionally", async () => {
    const harness = createRefundTransaction();

    await expect(
      allocatePartialRefund(harness.tx, {
        parentOrderId: harness.review.parentOrderId,
        reviewEventId: harness.review.id,
        actorId: "admin_synthetic_1",
        allocations: [
          { orderItemId: "item_refund_synthetic_1", refundMinor: 3000 },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(harness.reversals).toEqual([
      expect.objectContaining({
        entryType: SellerCommissionEntryType.REVERSAL,
        amountMinor: -300,
        eligibleBaseMinor: 3000,
        reversalOfId: "ledger_accrual_refund_1",
        idempotencyKey:
          "seller-commission:partial:refund_review_synthetic_1:ledger_accrual_refund_1",
      }),
    ]);
    expect(
      harness.calls.sellerCommissionReviewEvent.update,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: harness.review.id },
        data: expect.objectContaining({
          status: "POSTED",
          reviewedById: "admin_synthetic_1",
          allocationJson: [
            { orderItemId: "item_refund_synthetic_1", refundMinor: 3000 },
          ],
        }),
      }),
    );
  });

  it("rejects allocations that mismatch verified refunds or have no source accrual", async () => {
    const mismatched = createRefundTransaction();

    await expect(
      allocatePartialRefund(mismatched.tx, {
        parentOrderId: mismatched.review.parentOrderId,
        reviewEventId: mismatched.review.id,
        actorId: "admin_synthetic_1",
        allocations: [
          { orderItemId: "item_refund_synthetic_1", refundMinor: 2999 },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      mismatched.calls.sellerCommissionLedgerEntry.createMany,
    ).not.toHaveBeenCalled();

    const missingAccrual = createRefundTransaction({ accrual: null });
    await expect(
      allocatePartialRefund(missingAccrual.tx, {
        parentOrderId: missingAccrual.review.parentOrderId,
        reviewEventId: missingAccrual.review.id,
        actorId: "admin_synthetic_1",
        allocations: [
          { orderItemId: "item_refund_synthetic_1", refundMinor: 3000 },
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "COMMISSION_ACCRUAL_MISSING",
    });
    expect(
      missingAccrual.calls.sellerCommissionLedgerEntry.createMany,
    ).not.toHaveBeenCalled();
  });
});
