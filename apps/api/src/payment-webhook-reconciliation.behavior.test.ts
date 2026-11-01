import { PaymentMethod, PaymentStatus, type Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  accrueSellerCommissions: vi.fn(async () => 1),
  notifyOrderParties: vi.fn(async () => undefined),
  reverseAffiliate: vi.fn(async () => undefined),
  reverseClubCoins: vi.fn(async () => undefined),
  settleAffiliate: vi.fn(async () => undefined),
}));

vi.mock("./seller-commission.js", () => ({
  accrueSellerCommissionsForPaidOrder: dependencies.accrueSellerCommissions,
  createPartialRefundReview: vi.fn(async () => 1),
  reverseSellerCommissionForOrder: vi.fn(async () => 1),
}));
vi.mock("./affiliate-ledger.js", () => ({
  reverseAffiliateForOrderInTransaction: dependencies.reverseAffiliate,
  settleAffiliateForPaidOrderInTransaction: dependencies.settleAffiliate,
}));
vi.mock("./club-coins-awards.js", () => ({
  reverseClubCoinsForOrder: dependencies.reverseClubCoins,
}));
vi.mock("./order-notifications.js", () => ({
  notifyOrderParties: dependencies.notifyOrderParties,
}));

import {
  reconcileVerifiedPaymentEvent,
  type VerifiedPaymentEvent,
} from "./payment-webhook-reconciliation.js";

const orderId = "order_synthetic_capture_1";
const paymentId = "payment_synthetic_capture_1";

function captureEvent(): VerifiedPaymentEvent {
  return {
    provider: "STRIPE",
    eventId: "evt_synthetic_capture_1",
    eventType: "checkout.session.completed",
    providerObjectRef: "pi_synthetic_capture_1",
    paymentLookupRef: "cs_synthetic_capture_1",
    metadataOrderId: orderId,
    amountMinor: 2500,
    currency: "usd",
    providerTotalMinor: 2500,
    occurredAt: new Date("2026-10-29T12:34:56.000Z"),
    captureConfirmed: true,
  };
}

function createTransaction() {
  let paymentStatus: PaymentStatus = PaymentStatus.PENDING;
  let persistedEvent: Record<string, unknown> | null = null;

  const tx = {
    $queryRaw: vi.fn(async () => [{ id: orderId }]),
    processedWebhookEvent: {
      findUnique: vi.fn(async () => persistedEvent),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "webhook_synthetic_capture_1",
      })),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        persistedEvent = { id: "webhook_synthetic_capture_1", ...data };
        return persistedEvent;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        persistedEvent = { ...persistedEvent, ...data };
        return persistedEvent;
      }),
    },
    payment: {
      findMany: vi.fn(async () => [
        {
          id: paymentId,
          parentId: orderId,
          providerRef: "cs_synthetic_capture_1",
        },
      ]),
      findUnique: vi.fn(async () => ({
        id: paymentId,
        parentId: orderId,
        method: PaymentMethod.STRIPE,
        status: paymentStatus,
        attempts: [],
      })),
      findUniqueOrThrow: vi.fn(async () => ({ status: paymentStatus })),
      updateMany: vi.fn(async () => {
        paymentStatus = PaymentStatus.PAID;
        return { count: 1 };
      }),
    },
    paymentAttempt: { update: vi.fn(async () => undefined) },
    parentOrder: {
      findUnique: vi.fn(async () => ({
        id: orderId,
        orderNumber: "SYNTH-1001",
        buyerId: "buyer_synthetic_1",
        totalMinor: 2500,
        currency: "USD",
        status: "PENDING",
        sellerOrders: [
          {
            id: "seller_order_synthetic_1",
            sellerId: "seller_synthetic_1",
            status: "PENDING",
          },
        ],
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    calls: tx,
    get persistedEvent() {
      return persistedEvent;
    },
  };
}

describe("verified payment capture reconciliation behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not mark a payment paid or accrue commission when capture amount differs", async () => {
    const harness = createTransaction();
    const event = { ...captureEvent(), amountMinor: 2499 };

    const result = await reconcileVerifiedPaymentEvent(harness.tx, event);

    expect(result).toMatchObject({
      orderId,
      becamePaid: false,
      reviewReason: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH",
    });
    expect(harness.calls.payment.updateMany).not.toHaveBeenCalled();
    expect(dependencies.accrueSellerCommissions).not.toHaveBeenCalled();
    expect(harness.calls.processedWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reviewReason: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH" },
      }),
    );
  });

  it("confirms a verified matching capture and makes an exact replay a no-op", async () => {
    const harness = createTransaction();
    const event = captureEvent();

    const first = await reconcileVerifiedPaymentEvent(harness.tx, event);
    const replay = await reconcileVerifiedPaymentEvent(harness.tx, event);

    expect(first).toMatchObject({
      orderId,
      becamePaid: true,
      reviewReason: null,
    });
    expect(replay).toMatchObject({
      orderId,
      becamePaid: false,
      reviewReason: null,
    });
    expect(harness.calls.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.calls.parentOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(dependencies.accrueSellerCommissions).toHaveBeenCalledTimes(1);
    expect(dependencies.settleAffiliate).toHaveBeenCalledTimes(1);
    expect(harness.persistedEvent).toMatchObject({
      identityVerified: true,
      reviewReason: null,
      providerObjectRef: event.providerObjectRef,
      paymentLookupRef: event.paymentLookupRef,
    });
  });
});
