import assert from "node:assert/strict";
import Stripe from "stripe";

export function createSellerCommissionPaymentHelpers({
  prisma,
  webhookSecret,
  baseUrl,
  sessionToken,
  csrfToken,
  seller,
  sellerSessionToken,
  sellerCsrfToken,
  policy,
  product,
  affiliate,
  affiliateLink,
  suffix,
  reconcileVerifiedPaymentEvent,
  paypalWebhookEventToVerifiedPaymentEvent,
}) {
  const createdOrderIds = [];

  async function createOrder(
    label,
    {
      zeroCommission = false,
      knownPaymentIntentReference = false,
      unassociatedPaymentReference = false,
      affiliateClickId,
      method = "STRIPE",
    } = {},
  ) {
    const sessionId = `cs_synthetic_${label}_${suffix}`;
    const paymentIntentId = `pi_synthetic_${label}_${suffix}`;
    const paypalOrderId = `paypal_synthetic_${label}_${suffix}`;
    const commissionSnapshotJson = zeroCommission
      ? {
          version: 1,
          policyVersionId: null,
          source: "DEFAULT_ZERO",
          type: "ZERO",
          fixedMinor: null,
          basisPoints: null,
          minimumMinor: null,
          capMinor: null,
          currency: "USD",
          capturedAt: new Date().toISOString(),
          reason: "No active policy; zero commission applies.",
        }
      : {
          version: 1,
          policyVersionId: policy.id,
          policyVersion: 1,
          source: "STORE",
          type: "PERCENTAGE",
          fixedMinor: null,
          basisPoints: 1_000,
          minimumMinor: null,
          capMinor: null,
          currency: "USD",
          capturedAt: new Date().toISOString(),
          reason: policy.reason,
        };
    const order = await prisma.parentOrder.create({
      data: {
        orderNumber: `MV-${suffix.slice(0, 12)}-${label}`,
        buyerEmail: "synthetic-buyer@example.test",
        buyerName: "Synthetic Buyer",
        addressJson: { country: "US" },
        totalMinor: 10_000,
        currency: "USD",
        affiliateClickId,
        sellerOrders: {
          create: {
            sellerId: seller.id,
            totalMinor: 10_000,
            status: "PENDING",
            commissionPolicyVersionId: zeroCommission ? null : policy.id,
            commissionSnapshotJson,
            items: {
              create: {
                productId: product.id,
                productName: product.name,
                unitPriceMinor: 10_000,
                quantity: 1,
                currencySnapshot: "USD",
              },
            },
          },
        },
        payment: {
          create: {
            method,
            status: "PENDING",
            providerRef:
              method === "PAYPAL"
                ? paypalOrderId
                : unassociatedPaymentReference
                  ? `unassociated_${label}_${suffix}`
                  : knownPaymentIntentReference
                    ? paymentIntentId
                    : sessionId,
          },
        },
      },
      include: { sellerOrders: { include: { items: true } } },
    });
    createdOrderIds.push(order.id);
    return { order, sessionId, paymentIntentId, paypalOrderId };
  }

  async function createAffiliateOrder(label, options = {}) {
    const click = await prisma.affiliateClick.create({
      data: {
        affiliateId: affiliate.id,
        linkId: affiliateLink.id,
        tokenHash: `affiliate-token-${label}-${suffix}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        consentGivenAt: new Date(),
      },
    });
    return {
      ...(await createOrder(label, { ...options, affiliateClickId: click.id })),
      click,
    };
  }

  async function deliverStripeEvent(event) {
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body: payload,
    });
    return { status: response.status, body: await response.text() };
  }

  async function sendStripeEvent(event) {
    const response = await deliverStripeEvent(event);
    assert.ok(
      [200, 202].includes(response.status),
      `Synthetic Stripe webhook returned ${response.status}: ${response.body}`,
    );
    const body = JSON.parse(response.body);
    assert.equal(body.received, true);
    assert.equal(
      body.reconciliation,
      response.status === 202 ? "REVIEW_REQUIRED" : "COMPLETE",
    );
    return { status: response.status, body };
  }

  async function resolveRefund(review, orderItemId, refundMinor) {
    const response = await fetch(
      `${baseUrl}/api/admin/seller-commission-reviews/${review.id}/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `marketplace_session=${sessionToken}; marketplace_csrf=${csrfToken}`,
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          allocations: [{ orderItemId, refundMinor }],
          reason: "Synthetic verified refund allocation",
        }),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  async function retryWebhookReview(
    eventId,
    reason = "Retry verified synthetic event",
  ) {
    const response = await fetch(
      `${baseUrl}/api/admin/seller-commission-webhook-events/${eventId}/retry`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `marketplace_session=${sessionToken}; marketplace_csrf=${csrfToken}`,
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ reason }),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  async function cancelSellerOrder(sellerOrderId) {
    const response = await fetch(
      `${baseUrl}/api/sellers/${seller.id}/orders/${sellerOrderId}/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `marketplace_session=${sellerSessionToken}; marketplace_csrf=${sellerCsrfToken}`,
          "x-csrf-token": sellerCsrfToken,
        },
        body: JSON.stringify({ status: "CANCELLED" }),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  async function waitForParentOrderLockWaiters(expected, label) {
    let observed = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw`SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%FROM "ParentOrder"%'
            AND query ILIKE '%FOR UPDATE%'`;
      observed = rows[0]?.count ?? 0;
      if (observed >= expected) return observed;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(
      `${label}: expected ${expected} independent transaction(s) waiting on the parent-order lock, observed ${observed}`,
    );
  }

  async function collectCodAs(orderId, token, csrfTokenValue) {
    const response = await fetch(
      `${baseUrl}/api/orders/${orderId}/cod-collect`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `marketplace_session=${token}; marketplace_csrf=${csrfTokenValue}`,
          "x-csrf-token": csrfTokenValue,
        },
        body: "{}",
      },
    );
    return { status: response.status, body: await response.json() };
  }

  async function collectCod(orderId) {
    return collectCodAs(orderId, sessionToken, csrfToken);
  }

  async function createPosSaleRequest(body) {
    const response = await fetch(`${baseUrl}/api/pos/sales`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `marketplace_session=${sellerSessionToken}; marketplace_csrf=${sellerCsrfToken}`,
        "x-csrf-token": sellerCsrfToken,
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json();
    return { status: response.status, body: responseBody };
  }

  function checkoutEvent(
    eventId,
    type,
    fixture,
    paymentStatus = "paid",
    created = Math.floor(Date.now() / 1_000),
  ) {
    return {
      id: eventId,
      object: "event",
      type,
      created,
      livemode: false,
      data: {
        object: {
          id: fixture.sessionId,
          object: "checkout.session",
          amount_total: 10_000,
          currency: "usd",
          payment_status: paymentStatus,
          payment_intent: fixture.paymentIntentId,
          metadata: { orderId: fixture.order.id },
        },
      },
    };
  }

  function refundEvent(
    eventId,
    fixture,
    cumulativeRefundMinor,
    created = Math.floor(Date.now() / 1_000),
  ) {
    return {
      id: eventId,
      object: "event",
      type: "charge.refunded",
      created,
      livemode: false,
      data: {
        object: {
          id: `ch_synthetic_${fixture.order.id}`,
          object: "charge",
          amount: 10_000,
          amount_refunded: cumulativeRefundMinor,
          currency: "usd",
          payment_intent: fixture.paymentIntentId,
        },
      },
    };
  }

  function disputeEvent(
    eventId,
    fixture,
    amountMinor,
    created = Math.floor(Date.now() / 1_000),
  ) {
    return {
      id: eventId,
      object: "event",
      type: "charge.dispute.created",
      created,
      livemode: false,
      data: {
        object: {
          id: `dp_synthetic_${fixture.order.id}`,
          object: "dispute",
          amount: amountMinor,
          currency: "usd",
          payment_intent: fixture.paymentIntentId,
          metadata: {},
        },
      },
    };
  }

  async function sendVerifiedPaypal(event) {
    return prisma.$transaction(
      (tx) => reconcileVerifiedPaymentEvent(tx, event),
      { isolationLevel: "ReadCommitted" },
    );
  }

  async function sendPaypalPayload(payload) {
    const event = await paypalWebhookEventToVerifiedPaymentEvent(
      payload,
      async (currency) => {
        const entry = await prisma.currencyCatalogEntry.findUnique({
          where: { code: currency },
          select: { minorUnitExponent: true },
        });
        return entry?.minorUnitExponent ?? null;
      },
    );
    return { event, result: await sendVerifiedPaypal(event) };
  }

  function paypalOrderCompletedPayload(
    eventId,
    fixture,
    {
      captureId = `cap_synthetic_${fixture.order.id}`,
      captureStatus = "COMPLETED",
      orderStatus = "COMPLETED",
      amount = "100.00",
      currency = "USD",
      customId = fixture.order.id,
      referenceId = fixture.order.id,
      captures = undefined,
    } = {},
  ) {
    return {
      id: eventId,
      event_type: "CHECKOUT.ORDER.COMPLETED",
      create_time: new Date().toISOString(),
      resource: {
        id: fixture.paypalOrderId,
        status: orderStatus,
        purchase_units: [
          {
            custom_id: customId,
            reference_id: referenceId,
            payments: {
              captures: captures ?? [
                {
                  id: captureId,
                  status: captureStatus,
                  amount: { currency_code: currency, value: amount },
                },
              ],
            },
          },
        ],
      },
    };
  }

  function paypalCaptureCompletedPayload(
    eventId,
    fixture,
    {
      captureId = `cap_synthetic_${fixture.order.id}`,
      status = "COMPLETED",
      amount = "100.00",
      currency = "USD",
    } = {},
  ) {
    return {
      id: eventId,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: new Date().toISOString(),
      resource: {
        id: captureId,
        status,
        amount: { currency_code: currency, value: amount },
        supplementary_data: {
          related_ids: { order_id: fixture.paypalOrderId },
        },
      },
    };
  }

  async function installAffiliateLedgerFailure() {
    const functionName = `test_affiliate_failure_${suffix}`;
    const triggerName = `${functionName}_trigger`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW."sourceEventId" LIKE 'evt_affiliate_atomicity_%' OR NEW."sourceEventId" LIKE 'cod-collection:%' THEN
            RAISE EXCEPTION 'synthetic affiliate ledger failure';
          END IF;
          RETURN NEW;
        END;
      $function$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "CommissionLedger" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
    );
    return async () => {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER "${triggerName}" ON "CommissionLedger"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    };
  }

  async function installPosCommissionFailure() {
    const functionName = `test_pos_commission_failure_${suffix}`;
    const triggerName = `${functionName}_trigger`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW."sourceEventId" LIKE 'pos:%' THEN
            RAISE EXCEPTION 'synthetic POS commission failure';
          END IF;
          RETURN NEW;
        END;
      $function$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "SellerCommissionLedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
    );
    return async () => {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER "${triggerName}" ON "SellerCommissionLedgerEntry"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    };
  }

  return {
    createOrder,
    createAffiliateOrder,
    deliverStripeEvent,
    sendStripeEvent,
    resolveRefund,
    retryWebhookReview,
    cancelSellerOrder,
    waitForParentOrderLockWaiters,
    collectCodAs,
    collectCod,
    createPosSaleRequest,
    checkoutEvent,
    refundEvent,
    disputeEvent,
    sendVerifiedPaypal,
    sendPaypalPayload,
    paypalOrderCompletedPayload,
    paypalCaptureCompletedPayload,
    installAffiliateLedgerFailure,
    installPosCommissionFailure,
  };
}
