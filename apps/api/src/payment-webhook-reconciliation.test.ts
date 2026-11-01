import { PaymentMethod } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  matchesPersistedPaymentEvent,
  type VerifiedPaymentEvent,
} from "./payment-webhook-reconciliation.js";

const occurredAt = new Date("2026-10-29T12:34:56.000Z");

const event: VerifiedPaymentEvent = {
  provider: "STRIPE",
  eventId: "evt_synthetic_123",
  eventType: "checkout.session.completed",
  providerObjectRef: " pi_synthetic_123 ",
  paymentLookupRef: " cs_synthetic_123 ",
  metadataOrderId: "order_synthetic_123",
  amountMinor: 2500,
  currency: "usd",
  providerTotalMinor: 2500,
  occurredAt,
  captureConfirmed: true,
};

const persisted = {
  id: "processed_event_synthetic_123",
  provider: PaymentMethod.STRIPE,
  eventId: "evt_synthetic_123",
  eventType: "checkout.session.completed",
  providerObjectRef: "pi_synthetic_123",
  paymentLookupRef: "cs_synthetic_123",
  metadataOrderId: "order_synthetic_123",
  amountMinor: 2500,
  currency: "USD",
  providerTotalMinor: 2500,
  providerOccurredAt: occurredAt,
  captureConfirmed: true,
  identityVerified: true,
};

describe("verified payment webhook identity matching", () => {
  it("accepts the same persisted event after normalizing reference whitespace and currency case", () => {
    expect(matchesPersistedPaymentEvent(event, persisted)).toBe(true);
  });

  it("accepts only the explicitly nullable legacy identity fields as unrecorded", () => {
    expect(
      matchesPersistedPaymentEvent(event, {
        ...persisted,
        providerObjectRef: null,
        paymentLookupRef: null,
        captureConfirmed: null,
      }),
    ).toBe(true);
  });

  it.each([
    ["provider", { provider: "PAYPAL" }],
    ["event id", { eventId: "evt_different" }],
    ["event type", { eventType: "charge.refunded" }],
    ["provider object reference", { providerObjectRef: "pi_different" }],
    ["payment lookup reference", { paymentLookupRef: "cs_different" }],
    ["order metadata", { metadataOrderId: "order_different" }],
    ["captured amount", { amountMinor: 2501 }],
    ["currency", { currency: "EUR" }],
    ["provider total", { providerTotalMinor: 2501 }],
    [
      "provider timestamp",
      { occurredAt: new Date(occurredAt.getTime() + 1000) },
    ],
    ["capture confirmation", { captureConfirmed: false }],
  ] as Array<[string, Partial<VerifiedPaymentEvent>]>)(
    "rejects a changed %s",
    (_fact, changes) => {
      expect(
        matchesPersistedPaymentEvent({ ...event, ...changes }, persisted),
      ).toBe(false);
    },
  );

  it("matches absent optional event facts only to null persisted values", () => {
    expect(
      matchesPersistedPaymentEvent(
        {
          provider: "PAYSTACK",
          eventId: "evt_legacy_1",
          eventType: "charge.success",
          providerObjectRef: null,
          paymentLookupRef: null,
        },
        {
          ...persisted,
          provider: PaymentMethod.PAYSTACK,
          eventId: "evt_legacy_1",
          eventType: "charge.success",
          providerObjectRef: null,
          paymentLookupRef: null,
          metadataOrderId: null,
          amountMinor: null,
          currency: null,
          providerTotalMinor: null,
          providerOccurredAt: null,
          captureConfirmed: null,
        },
      ),
    ).toBe(true);
  });
});
