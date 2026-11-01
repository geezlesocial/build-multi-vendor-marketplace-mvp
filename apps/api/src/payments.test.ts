import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createStripeSession = vi.fn(async (..._args: unknown[]) => ({
    id: "cs_synthetic",
    url: "https://checkout.stripe.com/c/synthetic",
  }));
  class MockStripe {
    checkout = { sessions: { create: createStripeSession } };
    constructor(readonly apiKey: string) {}
  }
  const env = {
    STRIPE_SECRET_KEY: "sk_test_synthetic_only",
    PAYMONGO_SECRET_KEY: "paymongo_synthetic_only",
    PAYSTACK_SECRET_KEY: "paystack_synthetic_only",
    PAYPAL_CLIENT_ID: "paypal_client_synthetic",
    PAYPAL_CLIENT_SECRET: "paypal_secret_synthetic",
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
    PAYPAL_WEBHOOK_ID: "paypal_webhook_synthetic",
  };
  const fetch = vi.fn();
  return { MockStripe, createStripeSession, env, fetch };
});

vi.mock("./config.js", () => ({ env: mocks.env }));
vi.mock("stripe", () => ({ default: mocks.MockStripe }));

import {
  capturePaypalOrder,
  createPaymongoCheckout,
  createPaystackTransaction,
  createPaypalOrder,
  createStripeCheckout,
  createStripeStoreBusterCheckout,
  verifyPaypalWebhook,
} from "./payments.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchCalls() {
  return mocks.fetch.mock.calls as unknown as [string, RequestInit?][];
}

function requestBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("payment provider request contracts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(mocks.env, {
      STRIPE_SECRET_KEY: "sk_test_synthetic_only",
      PAYMONGO_SECRET_KEY: "paymongo_synthetic_only",
      PAYSTACK_SECRET_KEY: "paystack_synthetic_only",
      PAYPAL_CLIENT_ID: "paypal_client_synthetic",
      PAYPAL_CLIENT_SECRET: "paypal_secret_synthetic",
      PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
      PAYPAL_WEBHOOK_ID: "paypal_webhook_synthetic",
    });
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.createStripeSession.mockResolvedValue({
      id: "cs_synthetic",
      url: "https://checkout.stripe.com/c/synthetic",
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a Stripe checkout with the saved order identity and retry-safe key", async () => {
    const order = {
      id: "order_synthetic_1",
      orderNumber: "ML-1001",
      totalMinor: 1299,
      currency: "USD",
      buyerEmail: "buyer@example.test",
    };

    await expect(
      createStripeCheckout(
        order,
        "https://market.test/return",
        "https://market.test/cancel",
      ),
    ).resolves.toMatchObject({ id: "cs_synthetic" });

    expect(mocks.createStripeSession).toHaveBeenCalledWith(
      {
        mode: "payment",
        customer_email: order.buyerEmail,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Marketplace order ML-1001" },
              unit_amount: 1299,
            },
            quantity: 1,
          },
        ],
        metadata: { orderId: order.id, orderNumber: order.orderNumber },
        success_url: "https://market.test/return",
        cancel_url: "https://market.test/cancel",
      },
      { idempotencyKey: `order-${order.id}` },
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves Store Buster funding identity in both Stripe session and payment-intent metadata", async () => {
    await createStripeStoreBusterCheckout(
      {
        fundingIntentId: "funding_synthetic_1",
        amountMinor: 2500,
        currency: "USD",
        buyerEmail: "seller@example.test",
      },
      "https://market.test/funded",
      "https://market.test/cancel",
    );

    const [session, options] = mocks.createStripeSession.mock
      .calls[0] as unknown as [
      {
        metadata: Record<string, string>;
        payment_intent_data: { metadata: Record<string, string> };
      },
      { idempotencyKey: string },
    ];
    expect(session.metadata).toEqual({
      purpose: "STORE_BUSTER_AD_BALANCE",
      fundingIntentId: "funding_synthetic_1",
    });
    expect(session.payment_intent_data.metadata).toEqual(session.metadata);
    expect(options.idempotencyKey).toBe(
      "store-buster-funding-funding_synthetic_1",
    );
  });

  it("creates PayMongo checkout only in PHP with an idempotent request and validated host", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "cs_paymongo_synthetic",
          attributes: {
            checkout_url: "https://checkout.paymongo.com/cs/synthetic",
          },
        },
      }),
    );

    await expect(
      createPaymongoCheckout(
        {
          id: "order_pm_1",
          orderNumber: "ML-PM-1",
          totalMinor: 12500,
          currency: "PHP",
        },
        "https://market.test/return",
        "https://market.test/cancel",
      ),
    ).resolves.toEqual({
      id: "cs_paymongo_synthetic",
      checkoutUrl: "https://checkout.paymongo.com/cs/synthetic",
    });

    const [url, init] = fetchCalls()[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe("https://api.paymongo.com/v2/checkout_sessions");
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("paymongo_synthetic_only:").toString("base64")}`,
    );
    expect(headers["Idempotency-Key"]).toBe("marketplace-checkout-order_pm_1");
    expect(requestBody(init)).toMatchObject({
      data: {
        attributes: {
          line_items: [{ amount: 12500, currency: "PHP", quantity: 1 }],
          reference_number: "order_pm_1",
          metadata: { orderId: "order_pm_1", orderNumber: "ML-PM-1" },
        },
      },
    });
  });

  it("rejects unsupported PayMongo currency and untrusted checkout redirects", async () => {
    await expect(
      createPaymongoCheckout(
        {
          id: "order_pm_2",
          orderNumber: "ML-PM-2",
          totalMinor: 100,
          currency: "USD",
        },
        "https://market.test/return",
        "https://market.test/cancel",
      ),
    ).rejects.toThrow("restricted to PHP");
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "cs_paymongo_invalid",
          attributes: { checkout_url: "https://checkout.attacker.test/" },
        },
      }),
    );
    await expect(
      createPaymongoCheckout(
        {
          id: "order_pm_3",
          orderNumber: "ML-PM-3",
          totalMinor: 100,
          currency: "PHP",
        },
        "https://market.test/return",
        "https://market.test/cancel",
      ),
    ).rejects.toThrow("invalid checkout session");
  });

  it("initializes Paystack using a sanitized reference and validates the returned reference", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/synthetic",
          access_code: "access_synthetic",
          reference: "MLorder123",
        },
      }),
    );
    const order = {
      id: "order/123",
      orderNumber: "ML-PS-1",
      totalMinor: 4800,
      currency: "NGN",
      buyerEmail: "buyer@example.test",
    };

    await expect(
      createPaystackTransaction(order, "https://market.test/return"),
    ).resolves.toEqual({
      authorizationUrl: "https://checkout.paystack.com/synthetic",
      reference: "MLorder123",
      accessCode: "access_synthetic",
    });

    const [url, init] = fetchCalls()[0]!;
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer paystack_synthetic_only",
    });
    expect(requestBody(init)).toMatchObject({
      email: order.buyerEmail,
      amount: "4800",
      currency: "NGN",
      reference: "MLorder123",
      callback_url: "https://market.test/return",
      metadata: { orderId: order.id, orderNumber: order.orderNumber },
    });
  });

  it("creates PayPal orders with the same request identity on retry", async () => {
    const order = {
      id: "order_synthetic_2",
      orderNumber: "ML-1002",
      totalMinor: 1299,
      currency: "USD",
    };
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ access_token: "access_synthetic" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "paypal_order_synthetic", status: "CREATED" }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: "access_synthetic" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "paypal_order_synthetic", status: "CREATED" }),
      );

    await createPaypalOrder(order);
    await createPaypalOrder(order);

    const orderRequests = fetchCalls().filter(([url]) =>
      url.endsWith("/v2/checkout/orders"),
    );
    const requestIds = orderRequests.map(
      ([, init]) =>
        (init?.headers as Record<string, string>)["PayPal-Request-Id"],
    );
    expect(requestIds[0]).toMatch(/^ml-o-[a-f0-9]{32}$/);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(requestBody(orderRequests[0]?.[1])).toMatchObject({
      purchase_units: [
        {
          reference_id: order.id,
          custom_id: order.id,
          amount: { currency_code: "USD", value: "12.99" },
        },
      ],
    });
  });

  it("uses a stable PayPal capture request identity for retries of the same order", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ access_token: "access_synthetic" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "paypal_order_synthetic", status: "COMPLETED" }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: "access_synthetic" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "paypal_order_synthetic", status: "COMPLETED" }),
      );

    await capturePaypalOrder("paypal/order/synthetic");
    await capturePaypalOrder("paypal/order/synthetic");

    const captureRequests = fetchCalls().filter(([url]) =>
      url.includes("/capture"),
    );
    const requestIds = captureRequests.map(
      ([, init]) =>
        (init?.headers as Record<string, string>)["PayPal-Request-Id"],
    );
    expect(captureRequests[0]?.[0]).toBe(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/paypal%2Forder%2Fsynthetic/capture",
    );
    expect(requestIds[0]).toMatch(/^ml-c-[a-f0-9]{32}$/);
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it("does not attempt PayPal webhook verification until a webhook ID is configured", async () => {
    mocks.env.PAYPAL_WEBHOOK_ID = "";

    await expect(
      verifyPaypalWebhook(Buffer.from('{"id":"evt_synthetic"}'), {}),
    ).resolves.toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
