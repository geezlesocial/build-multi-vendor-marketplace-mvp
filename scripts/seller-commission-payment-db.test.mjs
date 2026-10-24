import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Stripe from 'stripe';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required for the guarded disposable commission regression.');
const { databaseName } = validateE2EDatabaseURL(databaseUrl);
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID ?? '';
const identity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(databaseName)?.[1];
if (!identity || identity !== sandboxId) {
  throw new Error('Commission regression requires a wallet_funding_e2e_<id> database matching WALLET_FUNDING_SANDBOX_ID.');
}
const isolatedDotenvPath = path.join(os.tmpdir(), `marketplace-no-dotenv-${sandboxId}`);
if (existsSync(isolatedDotenvPath)) throw new Error('The isolated dotenv path unexpectedly exists; refusing to load environment files.');
process.env.DOTENV_CONFIG_PATH = isolatedDotenvPath;

const webhookSecret = 'whsec_synthetic_seller_commission_test_only';
process.env.DATABASE_URL = databaseUrl;
process.env.E2E_DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.SESSION_COOKIE_NAME = 'marketplace_session';
process.env.PASSWORD_PEPPER = 'synthetic-commission-test-pepper';
process.env.CURRENCY = 'USD';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_seller_commission_no_network';
process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.PAYPAL_WEBHOOK_ID = '';
process.env.MONEY_MOVEMENT_HARD_DISABLED = 'true';
process.env.WALLET_FUNDING_SANDBOX_MODE = 'false';
process.env.WALLET_FUNDING_PROVIDER_READY = 'false';
process.env.CLUB_COINS_HARD_DISABLED = 'true';
process.env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE = 'false';

test('synthetic provider captures and refunds reconcile seller commissions once with durable ledger invariants', async () => {
  const [{ prisma, tokenHash }, { app }, { allocatePartialRefund }, { reconcileVerifiedPaymentEvent }, { paypalWebhookEventToVerifiedPaymentEvent }, safety] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/index.ts'),
    import('../apps/api/src/seller-commission.ts'),
    import('../apps/api/src/payment-webhook-reconciliation.ts'),
    import('../apps/api/src/paypal-webhook-event.ts'),
    import('../apps/api/src/wallet-safety.ts')
  ]);
  assert.equal(safety.isDisposableWalletFundingDatabaseUrl(databaseUrl, sandboxId), true);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = randomUUID().replaceAll('-', '');
  const createdOrderIds = [];

  try {
    const admin = await prisma.user.create({ data: { email: `commission-admin-${suffix}@example.test`, name: 'Synthetic Commission Admin', role: 'ADMIN', passwordHash: 'synthetic-only' } });
    const sessionToken = randomUUID().replaceAll('-', '');
    const csrfToken = randomUUID().replaceAll('-', '');
    await prisma.session.create({ data: { userId: admin.id, tokenHash: tokenHash(sessionToken), expiresAt: new Date(Date.now() + 60_000) } });
    const sellerUser = await prisma.user.create({ data: { email: `commission-seller-${suffix}@example.test`, name: 'Synthetic Commission Seller', role: 'SELLER', passwordHash: 'synthetic-only' } });
    const seller = await prisma.seller.create({ data: { userId: sellerUser.id, status: 'APPROVED' } });
    const sellerSessionToken = randomUUID().replaceAll('-', '');
    const sellerCsrfToken = randomUUID().replaceAll('-', '');
    await prisma.session.create({ data: { userId: sellerUser.id, tokenHash: tokenHash(sellerSessionToken), expiresAt: new Date(Date.now() + 60_000) } });
    const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Synthetic Commission Store ${suffix}`, slug: `synthetic-commission-${suffix}` } });
    const product = await prisma.product.create({ data: { sellerId: seller.id, name: 'Synthetic Commission Product', slug: `synthetic-commission-product-${suffix}`, description: 'Database-only commission regression fixture', priceMinor: 10_000, currency: 'USD', status: 'APPROVED' } });
    const policy = await prisma.sellerCommissionPolicyVersion.create({ data: {
      version: 1, status: 'ACTIVE', storeId: store.id, type: 'PERCENTAGE', currency: 'USD', basisPoints: 1_000,
      reason: 'Synthetic database regression policy', createdById: admin.id, effectiveFrom: new Date(Date.now() - 60_000)
    } });
    await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { affiliateEnabled: true }, create: { id: 'default', affiliateEnabled: true } });
    const affiliateUser = await prisma.user.create({ data: { email: `commission-affiliate-${suffix}@example.test`, name: 'Synthetic Commission Affiliate', role: 'BUYER', passwordHash: 'synthetic-only' } });
    const affiliate = await prisma.affiliateProfile.create({ data: { userId: affiliateUser.id, status: 'APPROVED', referralCode: `affiliate-${suffix}`, termsAcceptedAt: new Date() } });
    const affiliateLink = await prisma.affiliateLink.create({ data: { affiliateId: affiliate.id, targetPath: '/', code: `affiliate-link-${suffix}` } });

    async function createOrder(label, { zeroCommission = false, knownPaymentIntentReference = false, unassociatedPaymentReference = false, affiliateClickId, method = 'STRIPE' } = {}) {
      const sessionId = `cs_synthetic_${label}_${suffix}`;
      const paymentIntentId = `pi_synthetic_${label}_${suffix}`;
      const paypalOrderId = `paypal_synthetic_${label}_${suffix}`;
      const commissionSnapshotJson = zeroCommission
        ? { version: 1, policyVersionId: null, source: 'DEFAULT_ZERO', type: 'ZERO', fixedMinor: null, basisPoints: null, minimumMinor: null, capMinor: null, currency: 'USD', capturedAt: new Date().toISOString(), reason: 'No active policy; zero commission applies.' }
        : { version: 1, policyVersionId: policy.id, policyVersion: 1, source: 'STORE', type: 'PERCENTAGE', fixedMinor: null, basisPoints: 1_000, minimumMinor: null, capMinor: null, currency: 'USD', capturedAt: new Date().toISOString(), reason: policy.reason };
      const order = await prisma.parentOrder.create({ data: {
        orderNumber: `MV-${suffix.slice(0, 12)}-${label}`,
        buyerEmail: 'synthetic-buyer@example.test', buyerName: 'Synthetic Buyer', addressJson: { country: 'US' },
        totalMinor: 10_000, currency: 'USD', affiliateClickId,
        sellerOrders: { create: {
          sellerId: seller.id, totalMinor: 10_000, status: 'PENDING', commissionPolicyVersionId: zeroCommission ? null : policy.id,
          commissionSnapshotJson,
          items: { create: { productId: product.id, productName: product.name, unitPriceMinor: 10_000, quantity: 1, currencySnapshot: 'USD' } }
        } },
        payment: { create: { method, status: 'PENDING', providerRef: method === 'PAYPAL' ? paypalOrderId : unassociatedPaymentReference ? `unassociated_${label}_${suffix}` : knownPaymentIntentReference ? paymentIntentId : sessionId } }
      }, include: { sellerOrders: { include: { items: true } } } });
      createdOrderIds.push(order.id);
      return { order, sessionId, paymentIntentId, paypalOrderId };
    }

    async function createAffiliateOrder(label, options = {}) {
      const click = await prisma.affiliateClick.create({ data: {
        affiliateId: affiliate.id, linkId: affiliateLink.id, tokenHash: `affiliate-token-${label}-${suffix}`,
        expiresAt: new Date(Date.now() + 60 * 60_000), consentGivenAt: new Date()
      } });
      return { ...(await createOrder(label, { ...options, affiliateClickId: click.id })), click };
    }

    async function deliverStripeEvent(event) {
      const payload = JSON.stringify(event);
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload
      });
      return { status: response.status, body: await response.text() };
    }

    async function sendStripeEvent(event) {
      const response = await deliverStripeEvent(event);
      assert.ok([200, 202].includes(response.status), `Synthetic Stripe webhook returned ${response.status}: ${response.body}`);
      const body = JSON.parse(response.body);
      assert.equal(body.received, true);
      assert.equal(body.reconciliation, response.status === 202 ? 'REVIEW_REQUIRED' : 'COMPLETE');
      return { status: response.status, body };
    }

    async function resolveRefund(review, orderItemId, refundMinor) {
      const response = await fetch(`${baseUrl}/api/admin/seller-commission-reviews/${review.id}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `marketplace_session=${sessionToken}; marketplace_csrf=${csrfToken}`,
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ allocations: [{ orderItemId, refundMinor }], reason: 'Synthetic verified refund allocation' })
      });
      return { status: response.status, body: await response.json() };
    }

    async function retryWebhookReview(eventId, reason = 'Retry verified synthetic event') {
      const response = await fetch(`${baseUrl}/api/admin/seller-commission-webhook-events/${eventId}/retry`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `marketplace_session=${sessionToken}; marketplace_csrf=${csrfToken}`,
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ reason })
      });
      return { status: response.status, body: await response.json() };
    }

    async function cancelSellerOrder(sellerOrderId) {
      const response = await fetch(`${baseUrl}/api/sellers/${seller.id}/orders/${sellerOrderId}/status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `marketplace_session=${sellerSessionToken}; marketplace_csrf=${sellerCsrfToken}`,
          'x-csrf-token': sellerCsrfToken
        },
        body: JSON.stringify({ status: 'CANCELLED' })
      });
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
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`${label}: expected ${expected} independent transaction(s) waiting on the parent-order lock, observed ${observed}`);
    }

    async function collectCodAs(orderId, token, csrfTokenValue) {
      const response = await fetch(`${baseUrl}/api/orders/${orderId}/cod-collect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `marketplace_session=${token}; marketplace_csrf=${csrfTokenValue}`,
          'x-csrf-token': csrfTokenValue
        },
        body: '{}'
      });
      return { status: response.status, body: await response.json() };
    }

    async function collectCod(orderId) {
      return collectCodAs(orderId, sessionToken, csrfToken);
    }

    async function createPosSaleRequest(body) {
      const response = await fetch(`${baseUrl}/api/pos/sales`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `marketplace_session=${sellerSessionToken}; marketplace_csrf=${sellerCsrfToken}`,
          'x-csrf-token': sellerCsrfToken
        },
        body: JSON.stringify(body)
      });
      const responseBody = await response.json();
      return { status: response.status, body: responseBody };
    }

    function checkoutEvent(eventId, type, fixture, paymentStatus = 'paid', created = Math.floor(Date.now() / 1_000)) {
      return {
        id: eventId, object: 'event', type, created, livemode: false,
        data: { object: {
          id: fixture.sessionId, object: 'checkout.session', amount_total: 10_000, currency: 'usd', payment_status: paymentStatus,
          payment_intent: fixture.paymentIntentId, metadata: { orderId: fixture.order.id }
        } }
      };
    }

    function refundEvent(eventId, fixture, cumulativeRefundMinor, created = Math.floor(Date.now() / 1_000)) {
      return {
        id: eventId, object: 'event', type: 'charge.refunded', created, livemode: false,
        data: { object: {
          id: `ch_synthetic_${fixture.order.id}`, object: 'charge', amount: 10_000, amount_refunded: cumulativeRefundMinor,
          currency: 'usd', payment_intent: fixture.paymentIntentId
        } }
      };
    }

    function disputeEvent(eventId, fixture, amountMinor, created = Math.floor(Date.now() / 1_000)) {
      return {
        id: eventId, object: 'event', type: 'charge.dispute.created', created, livemode: false,
        data: { object: {
          id: `dp_synthetic_${fixture.order.id}`, object: 'dispute', amount: amountMinor,
          currency: 'usd', payment_intent: fixture.paymentIntentId, metadata: {}
        } }
      };
    }

    async function sendVerifiedPaypal(event) {
      return prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, event), { isolationLevel: 'ReadCommitted' });
    }

    async function sendPaypalPayload(payload) {
      const event = await paypalWebhookEventToVerifiedPaymentEvent(payload, async currency => {
        const entry = await prisma.currencyCatalogEntry.findUnique({ where: { code: currency }, select: { minorUnitExponent: true } });
        return entry?.minorUnitExponent ?? null;
      });
      return { event, result: await sendVerifiedPaypal(event) };
    }

    function paypalOrderCompletedPayload(eventId, fixture, { captureId = `cap_synthetic_${fixture.order.id}`, captureStatus = 'COMPLETED', orderStatus = 'COMPLETED', amount = '100.00', currency = 'USD', customId = fixture.order.id, referenceId = fixture.order.id, captures = undefined } = {}) {
      return {
        id: eventId, event_type: 'CHECKOUT.ORDER.COMPLETED', create_time: new Date().toISOString(),
        resource: {
          id: fixture.paypalOrderId, status: orderStatus,
          purchase_units: [{ custom_id: customId, reference_id: referenceId, payments: { captures: captures ?? [{ id: captureId, status: captureStatus, amount: { currency_code: currency, value: amount } }] } }]
        }
      };
    }

    function paypalCaptureCompletedPayload(eventId, fixture, { captureId = `cap_synthetic_${fixture.order.id}`, status = 'COMPLETED', amount = '100.00', currency = 'USD' } = {}) {
      return {
        id: eventId, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: new Date().toISOString(),
        resource: {
          id: captureId, status, amount: { currency_code: currency, value: amount },
          supplementary_data: { related_ids: { order_id: fixture.paypalOrderId } }
        }
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
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "CommissionLedger" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
      return async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "CommissionLedger"`);
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
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "SellerCommissionLedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
      return async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "SellerCommissionLedgerEntry"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
      };
    }

    // Rows written by the old marketplace webhook handler contained only the
    // provider and event ID. A verified redelivery may bind one safely from
    // actual local payment references; metadata alone must never bind it.
    const legacySafe = await createAffiliateOrder('legacy-safe-replay');
    const legacySafeEvent = checkoutEvent(`evt_legacy_safe_${suffix}`, 'checkout.session.completed', legacySafe);
    const legacySafeRow = await prisma.processedWebhookEvent.create({ data: {
      provider: 'STRIPE', eventId: legacySafeEvent.id, identityVerified: false,
      reviewReason: 'LEGACY_EVENT_REQUIRES_RECONCILIATION'
    } });
    const legacySafeDelivery = await sendStripeEvent(legacySafeEvent);
    assert.equal(legacySafeDelivery.status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: legacySafe.order.id } })).status, 'PAID');
    const legacySafePersisted = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: legacySafeRow.id } });
    assert.equal(legacySafePersisted.identityVerified, true);
    assert.equal(legacySafePersisted.eventType, 'checkout.session.completed');
    assert.equal(legacySafePersisted.parentOrderId, legacySafe.order.id);
    assert.equal(legacySafePersisted.reviewReason, null);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: legacySafe.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacySafe.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', entityId: legacySafeRow.id } }), 1);
    await sendStripeEvent(legacySafeEvent);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: legacySafe.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', entityId: legacySafeRow.id } }), 1);

    const legacyAwaiting = await createAffiliateOrder('legacy-awaiting-reference', { unassociatedPaymentReference: true });
    const legacyAwaitingEvent = checkoutEvent(`evt_legacy_waiting_${suffix}`, 'checkout.session.completed', legacyAwaiting);
    const legacyAwaitingRow = await prisma.processedWebhookEvent.create({ data: {
      provider: 'STRIPE', eventId: legacyAwaitingEvent.id, identityVerified: false,
      reviewReason: 'LEGACY_EVENT_REQUIRES_RECONCILIATION'
    } });
    const legacyHeld = await sendStripeEvent(legacyAwaitingEvent);
    assert.equal(legacyHeld.status, 202);
    assert.equal(legacyHeld.body.reconciliation, 'REVIEW_REQUIRED');
    const legacyHeldRow = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: legacyAwaitingRow.id } });
    assert.equal(legacyHeldRow.identityVerified, true);
    assert.equal(legacyHeldRow.parentOrderId, null);
    assert.equal(legacyHeldRow.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: legacyAwaiting.order.id } })).status, 'PENDING');
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacyAwaiting.order.id } } } }), 0);
    await prisma.payment.update({ where: { parentId: legacyAwaiting.order.id }, data: { providerRef: legacyAwaiting.sessionId } });
    const legacyRetry = await retryWebhookReview(legacyAwaitingRow.id);
    assert.equal(legacyRetry.status, 200, JSON.stringify(legacyRetry.body));
    assert.equal(legacyRetry.body.reconciliation, 'COMPLETE');
    await sendStripeEvent(legacyAwaitingEvent);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: legacyAwaiting.order.id } })).status, 'PAID');
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: legacyAwaitingRow.id } })).reviewReason, null);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: legacyAwaiting.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacyAwaiting.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: legacyAwaitingRow.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_WEBHOOK_RECONCILIATION_RETRIED', entityId: legacyAwaitingRow.id } }), 1);

    const legacyConflict = await createAffiliateOrder('legacy-conflicting-metadata');
    const legacyForeign = await createOrder('legacy-foreign-metadata-target');
    const legacyConflictEvent = checkoutEvent(`evt_legacy_conflict_${suffix}`, 'checkout.session.completed', legacyConflict);
    legacyConflictEvent.data.object.metadata.orderId = legacyForeign.order.id;
    const legacyConflictRow = await prisma.processedWebhookEvent.create({ data: {
      provider: 'STRIPE', eventId: legacyConflictEvent.id, identityVerified: false,
      reviewReason: 'LEGACY_EVENT_REQUIRES_RECONCILIATION'
    } });
    const conflictDelivery = await sendStripeEvent(legacyConflictEvent);
    assert.equal(conflictDelivery.status, 202);
    const conflictRetry = await retryWebhookReview(legacyConflictRow.id);
    assert.equal(conflictRetry.status, 202);
    assert.equal(conflictRetry.body.reviewReason, 'ORDER_PAYMENT_REFERENCE_MISMATCH');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: legacyConflict.order.id } })).status, 'PENDING');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: legacyForeign.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: legacyConflict.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacyConflict.order.id } } } }), 0);
    const legacyConflictPersisted = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: legacyConflictRow.id } });
    assert.equal(legacyConflictPersisted.identityVerified, true);
    assert.equal(legacyConflictPersisted.parentOrderId, legacyConflict.order.id);
    assert.equal(legacyConflictPersisted.reviewReason, 'ORDER_PAYMENT_REFERENCE_MISMATCH');
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: legacyConflictRow.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_WEBHOOK_RECONCILIATION_RETRIED', entityId: legacyConflictRow.id } }), 1);

    // COD collection and affiliate settlement must roll back together. The
    // trigger injects a failure at the affiliate-ledger insert boundary.
    const legacyCollectedCod = await createAffiliateOrder('cod-legacy-collected-retry', { method: 'COD' });
    await prisma.payment.update({ where: { parentId: legacyCollectedCod.order.id }, data: { status: 'PAID', paidAt: new Date() } });
    await prisma.parentOrder.update({ where: { id: legacyCollectedCod.order.id }, data: { status: 'CONFIRMED' } });
    await prisma.sellerOrder.update({ where: { id: legacyCollectedCod.order.sellerOrders[0].id }, data: { status: 'FULFILLED' } });
    const otherSellerUser = await prisma.user.create({ data: { email: `commission-other-seller-${suffix}@example.test`, name: 'Synthetic Other Seller', role: 'SELLER', passwordHash: 'synthetic-only' } });
    const otherSeller = await prisma.seller.create({ data: { userId: otherSellerUser.id, status: 'APPROVED' } });
    const otherSellerToken = randomUUID().replaceAll('-', '');
    const otherSellerCsrf = randomUUID().replaceAll('-', '');
    await prisma.session.create({ data: { userId: otherSellerUser.id, tokenHash: tokenHash(otherSellerToken), expiresAt: new Date(Date.now() + 60_000) } });
    assert.notEqual(otherSeller.id, seller.id);
    const unauthorizedCodRetry = await collectCodAs(legacyCollectedCod.order.id, otherSellerToken, otherSellerCsrf);
    assert.equal(unauthorizedCodRetry.status, 404, JSON.stringify(unauthorizedCodRetry.body));
    assert.equal((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: legacyCollectedCod.click.id } })).convertedAt, null);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacyCollectedCod.order.id } } } }), 0);
    const authorizedLegacyCodRetry = await collectCodAs(legacyCollectedCod.order.id, sellerSessionToken, sellerCsrfToken);
    assert.equal(authorizedLegacyCodRetry.status, 200, JSON.stringify(authorizedLegacyCodRetry.body));
    assert.ok((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: legacyCollectedCod.click.id } })).convertedAt);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: legacyCollectedCod.order.id } }, entryType: 'EARNED' } }), 1);

    const codAffiliate = await createAffiliateOrder('cod-collection-atomicity', { method: 'COD' });
    await prisma.sellerOrder.update({ where: { id: codAffiliate.order.sellerOrders[0].id }, data: { status: 'FULFILLED' } });
    const removeCodFailure = await installAffiliateLedgerFailure();
    try {
      const failedCollection = await collectCod(codAffiliate.order.id);
      assert.equal(failedCollection.status, 500, JSON.stringify(failedCollection.body));
    } finally { await removeCodFailure(); }
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: codAffiliate.order.id } })).status, 'PENDING');
    assert.equal((await prisma.parentOrder.findUniqueOrThrow({ where: { id: codAffiliate.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: codAffiliate.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: codAffiliate.order.id } } } }), 0);
    assert.equal((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: codAffiliate.click.id } })).convertedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { action: 'COD_CASH_COLLECTED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: codAffiliate.order.id } })).id } }), 0);
    const collected = await collectCod(codAffiliate.order.id);
    assert.equal(collected.status, 200, JSON.stringify(collected.body));
    const collectedRetry = await collectCod(codAffiliate.order.id);
    assert.equal(collectedRetry.status, 200);
    assert.equal(collectedRetry.body.alreadyCollected, true);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: codAffiliate.order.id } })).status, 'PAID');
    assert.equal((await prisma.parentOrder.findUniqueOrThrow({ where: { id: codAffiliate.order.id } })).status, 'CONFIRMED');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: codAffiliate.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: codAffiliate.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'COD_CASH_COLLECTED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: codAffiliate.order.id } })).id } }), 1);

    // POS inventory, order, payment, commission accrual, and sale audit are
    // one transaction. Inject a failure at the seller-ledger boundary, then
    // retry the same sale request after removing the synthetic trigger.
    await prisma.paymentMethodSettings.upsert({
      where: { method: 'POS' }, update: { enabled: true },
      create: { id: 'synthetic-pos', method: 'POS', enabled: true }
    });
    await prisma.inventory.create({ data: { productId: product.id, quantity: 10 } });
    const posPayload = { items: [{ productId: product.id, quantity: 1 }], register: `replay-${suffix.slice(0, 8)}`, buyerName: 'Synthetic POS Buyer' };
    const posPaymentCountBefore = await prisma.payment.count({ where: { method: 'POS' } });
    const posSessionCountBefore = await prisma.pOSSession.count({ where: { sellerId: seller.id } });
    const posAuditCountBefore = await prisma.auditLog.count({ where: { action: 'POS_SALE_COMPLETED' } });
    const posFailure = await installPosCommissionFailure();
    try {
      const failedPosSale = await createPosSaleRequest(posPayload);
      assert.equal(failedPosSale.status, 500, JSON.stringify(failedPosSale.body));
    } finally { await posFailure(); }
    assert.equal(await prisma.payment.count({ where: { method: 'POS' } }), posPaymentCountBefore);
    assert.equal(await prisma.pOSSession.count({ where: { sellerId: seller.id } }), posSessionCountBefore);
    assert.equal((await prisma.inventory.findUniqueOrThrow({ where: { productId: product.id } })).quantity, 10);
    assert.equal(await prisma.auditLog.count({ where: { action: 'POS_SALE_COMPLETED' } }), posAuditCountBefore);

    const successfulPosSale = await createPosSaleRequest(posPayload);
    assert.equal(successfulPosSale.status, 201, JSON.stringify(successfulPosSale.body));
    const posOrder = await prisma.parentOrder.findUniqueOrThrow({
      where: { id: successfulPosSale.body.orderId },
      include: { payment: true, sellerOrders: { include: { items: true } } }
    });
    assert.equal(posOrder.payment.method, 'POS');
    assert.equal(posOrder.payment.status, 'PAID');
    assert.equal(posOrder.status, 'CONFIRMED');
    assert.equal(posOrder.sellerOrders[0].status, 'FULFILLED');
    assert.equal((await prisma.inventory.findUniqueOrThrow({ where: { productId: product.id } })).quantity, 9);
    assert.deepEqual((await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: posOrder.id } } })).map(entry => [entry.entryType, entry.amountMinor, entry.currency]), [['ACCRUAL', 1_000, 'USD']]);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: posOrder.id } } } }), 0, 'POS has no affiliate attribution input, so it must not fabricate affiliate earnings.');
    assert.equal(await prisma.auditLog.count({ where: { action: 'POS_SALE_COMPLETED', entityId: posOrder.id } }), 1);

    // Hold the parent row, start cancellation and a signed refund concurrently,
    // and release only after PostgreSQL confirms both requests are blocked on
    // that same row lock. This exercises real independent server transactions.
    const reversalRace = await createAffiliateOrder('cancel-refund-concurrency');
    const unrelatedOrder = await createAffiliateOrder('cancel-refund-control');
    const raceCapture = checkoutEvent(`evt_cancel_refund_capture_${suffix}`, 'checkout.session.completed', reversalRace);
    const unrelatedCapture = checkoutEvent(`evt_cancel_refund_control_capture_${suffix}`, 'checkout.session.completed', unrelatedOrder);
    await sendStripeEvent(raceCapture);
    await sendStripeEvent(unrelatedCapture);
    await prisma.affiliateProfile.update({ where: { id: affiliate.id }, data: { status: 'PAUSED' } });
    const raceRefund = refundEvent(`evt_cancel_refund_race_${suffix}`, reversalRace, 2_000);
    let releaseParentLock;
    let signalParentLockHeld;
    const releaseParentLockPromise = new Promise(resolve => { releaseParentLock = resolve; });
    const parentLockHeld = new Promise(resolve => { signalParentLockHeld = resolve; });
    const parentLockTransaction = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${reversalRace.order.id} FOR UPDATE`;
      signalParentLockHeld();
      await releaseParentLockPromise;
    }, { timeout: 30_000 });
    await parentLockHeld;
    const cancellationPromise = cancelSellerOrder(reversalRace.order.sellerOrders[0].id);
    const refundPromise = deliverStripeEvent(raceRefund);
    let observedWaiters = 0;
    const waitDeadline = Date.now() + 15_000;
    while (Date.now() < waitDeadline) {
      const rows = await prisma.$queryRaw`SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%ParentOrder%'
          AND query ILIKE '%FOR UPDATE%'`;
      observedWaiters = rows[0]?.count ?? 0;
      if (observedWaiters >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(observedWaiters >= 2, `Expected cancellation and refund sessions waiting on the parent-order lock, observed ${observedWaiters}`);
    releaseParentLock();
    await parentLockTransaction;
    const [cancelledRace, refundedRace] = await Promise.all([cancellationPromise, refundPromise]);
    assert.equal(cancelledRace.status, 200, JSON.stringify(cancelledRace.body));
    assert.equal(refundedRace.status, 200, `Concurrent synthetic refund returned ${refundedRace.status}: ${refundedRace.body}`);

    const raceEarned = await prisma.commissionLedger.findFirstOrThrow({ where: { orderItem: { sellerOrder: { parentId: reversalRace.order.id } }, entryType: 'EARNED' } });
    const raceReversals = await prisma.commissionLedger.findMany({ where: { reversalOfId: raceEarned.id }, orderBy: { id: 'asc' } });
    const reversedTotal = -raceReversals.reduce((sum, entry) => sum + entry.amountMinor, 0);
    assert.ok(reversedTotal <= raceEarned.amountMinor, 'Combined cancellation/refund reversals must not exceed the earned affiliate commission.');
    assert.equal(reversedTotal, raceEarned.amountMinor, 'The seller cancellation must reverse the remaining eligible affiliate commission.');
    assert.equal(new Set(raceReversals.map(entry => entry.idempotencyKey)).size, raceReversals.length);
    const raceAdjustments = await prisma.affiliateAdjustment.findMany({ where: { orderId: reversalRace.order.id }, select: { id: true } });
    assert.equal(raceAdjustments.length, 2);
    assert.equal(await prisma.auditLog.count({ where: { action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED', entityId: { in: raceAdjustments.map(row => row.id) } } }), 2);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: unrelatedOrder.order.id } }, entryType: 'REVERSAL' } }), 0);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: unrelatedOrder.order.id } })).status, 'PAID');
    const reversalsBeforeRetry = await prisma.commissionLedger.count({ where: { reversalOfId: raceEarned.id } });
    const adjustmentAuditsBeforeRetry = await prisma.auditLog.count({ where: { action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED', entity: 'AffiliateAdjustment', entityId: { in: raceAdjustments.map(row => row.id) } } });
    await sendStripeEvent(raceRefund);
    assert.equal((await cancelSellerOrder(reversalRace.order.sellerOrders[0].id)).status, 200);
    assert.equal(await prisma.commissionLedger.count({ where: { reversalOfId: raceEarned.id } }), reversalsBeforeRetry);
    assert.equal(await prisma.auditLog.count({ where: { action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED', entity: 'AffiliateAdjustment', entityId: { in: raceAdjustments.map(row => row.id) } } }), adjustmentAuditsBeforeRetry);
    await prisma.affiliateProfile.update({ where: { id: affiliate.id }, data: { status: 'APPROVED' } });

    // Cancellation and capture must serialize on the parent order. Exercise
    // both lock acquisition orders with independent HTTP/DB transactions and
    // let PostgreSQL lock-wait state, not a sleep, gate each interleaving.
    async function runCancellationCaptureRace(label, captureGetsLockFirst) {
      const raced = await createAffiliateOrder(`${label}-target`);
      const control = await createAffiliateOrder(`${label}-unrelated-control`);
      const capture = checkoutEvent(`evt_${label}_capture_${suffix}`, 'checkout.session.completed', raced);
      const controlCapture = checkoutEvent(`evt_${label}_control_capture_${suffix}`, 'checkout.session.completed', control);
      let releaseLock;
      let signalLockHeld;
      const release = new Promise(resolve => { releaseLock = resolve; });
      const held = new Promise(resolve => { signalLockHeld = resolve; });
      const lockTransaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${raced.order.id} FOR UPDATE`;
        signalLockHeld();
        await release;
      }, { timeout: 30_000 });
      await held;
      let capturePromise;
      let cancelPromise;
      try {
        if (captureGetsLockFirst) {
          capturePromise = deliverStripeEvent(capture);
          await waitForParentOrderLockWaiters(1, `${label}: capture queued first`);
          cancelPromise = cancelSellerOrder(raced.order.sellerOrders[0].id);
        } else {
          cancelPromise = cancelSellerOrder(raced.order.sellerOrders[0].id);
          await waitForParentOrderLockWaiters(1, `${label}: cancellation queued first`);
          capturePromise = deliverStripeEvent(capture);
        }
        await waitForParentOrderLockWaiters(2, `${label}: both operations queued`);

        // The parent lock is per-order: an unrelated order must settle while
        // these two transactions remain blocked on the target order.
        const controlResult = await sendStripeEvent(controlCapture);
        assert.equal(controlResult.status, 200);
        const controlPayment = await prisma.payment.findUniqueOrThrow({ where: { parentId: control.order.id } });
        assert.equal(controlPayment.status, 'PAID');
        assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: control.order.id }, entryType: 'ACCRUAL' } }), 1);
        assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: control.order.id } }, entryType: 'EARNED' } }), 1);

        releaseLock();
        await lockTransaction;
        const [cancelled, captured] = await Promise.all([cancelPromise, capturePromise]);
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(captured.status, captureGetsLockFirst ? 200 : 202, captured.body);
        const captureBody = JSON.parse(captured.body);
        assert.equal(captureBody.received, true);
        assert.equal(captureBody.reconciliation, captureGetsLockFirst ? 'COMPLETE' : 'REVIEW_REQUIRED');

        const payment = await prisma.payment.findUniqueOrThrow({ where: { parentId: raced.order.id } });
        const parent = await prisma.parentOrder.findUniqueOrThrow({ where: { id: raced.order.id } });
        const sellerOrder = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: raced.order.sellerOrders[0].id }, include: { items: true } });
        const captureEvent = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: capture.id } } });
        const sellerEntries = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrderId: sellerOrder.id }, orderBy: { createdAt: 'asc' } });
        const affiliateEntries = await prisma.commissionLedger.findMany({ where: { orderItemId: sellerOrder.items[0].id }, orderBy: { createdAt: 'asc' } });
        const adjustments = await prisma.affiliateAdjustment.findMany({ where: { orderId: raced.order.id } });

        assert.equal(payment.status, 'PAID');
        assert.equal(sellerOrder.status, 'CANCELLED');
        assert.equal(parent.status, 'CANCELLED');
        assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: capture.id } }), 1);
        assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: payment.id } }), 1);
        assert.equal(await prisma.auditLog.count({ where: { action: 'ORDER_STATUS_CHANGED', entityId: sellerOrder.id } }), 1);
        assert.equal(await prisma.auditLog.count({ where: { action: 'PARENT_ORDER_CANCELLED_AFTER_SELLER_CANCELLATION', entityId: parent.id } }), 1);

        if (captureGetsLockFirst) {
          assert.equal(captureEvent.reviewReason, null);
          assert.deepEqual(sellerEntries.map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);
          assert.deepEqual(affiliateEntries.map(row => [row.entryType, row.amountMinor]), [['EARNED', 500], ['REVERSAL', -500]]);
          assert.equal(adjustments.length, 1);
          assert.equal(adjustments[0].amountMinor, 500);
          assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_AFTER_SELLER_CANCELLATION_REQUIRES_REVIEW', entityId: captureEvent.id } }), 0);
        } else {
          assert.equal(captureEvent.reviewReason, 'CAPTURE_AFTER_SELLER_CANCELLATION_REQUIRES_REVIEW');
          assert.deepEqual(sellerEntries, []);
          assert.deepEqual(affiliateEntries, []);
          assert.equal(adjustments.length, 1);
          assert.equal(adjustments[0].amountMinor, 0);
          assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_AFTER_SELLER_CANCELLATION_REQUIRES_REVIEW', entityId: captureEvent.id } }), 1);
        }
        const earnedSeller = sellerEntries.find(row => row.entryType === 'ACCRUAL');
        if (earnedSeller) {
          const sellerReversed = -sellerEntries.filter(row => row.reversalOfId === earnedSeller.id).reduce((sum, row) => sum + row.amountMinor, 0);
          assert.ok(sellerReversed <= earnedSeller.amountMinor);
          assert.equal(sellerEntries.reduce((sum, row) => sum + row.amountMinor, 0), 0);
        }
        const earnedAffiliate = affiliateEntries.find(row => row.entryType === 'EARNED');
        if (earnedAffiliate) {
          const affiliateReversed = -affiliateEntries.filter(row => row.reversalOfId === earnedAffiliate.id).reduce((sum, row) => sum + row.amountMinor, 0);
          assert.ok(affiliateReversed <= earnedAffiliate.amountMinor);
          assert.equal(affiliateEntries.reduce((sum, row) => sum + row.amountMinor, 0), 0);
          assert.equal(await prisma.auditLog.count({ where: { action: 'AFFILIATE_COMMISSION_ADJUSTMENT_POSTED', entityId: adjustments[0].id } }), 1);
        }

        const sellerCountBeforeRetry = sellerEntries.length;
        const affiliateCountBeforeRetry = affiliateEntries.length;
        const relatedAuditEntityIds = [captureEvent.id, payment.id, sellerOrder.id, parent.id, adjustments[0].id];
        const auditCountBeforeRetry = await prisma.auditLog.count({ where: { entityId: { in: relatedAuditEntityIds } } });
        const duplicateCapture = await deliverStripeEvent(capture);
        assert.equal(duplicateCapture.status, captureGetsLockFirst ? 200 : 202, duplicateCapture.body);
        const duplicateCancel = await cancelSellerOrder(sellerOrder.id);
        assert.equal(duplicateCancel.status, 200, JSON.stringify(duplicateCancel.body));
        assert.equal(duplicateCancel.body.alreadyApplied, true);
        assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrderId: sellerOrder.id } }), sellerCountBeforeRetry);
        assert.equal(await prisma.commissionLedger.count({ where: { orderItemId: sellerOrder.items[0].id } }), affiliateCountBeforeRetry);
        assert.equal(await prisma.auditLog.count({ where: { entityId: { in: relatedAuditEntityIds } } }), auditCountBeforeRetry);
        assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: control.order.id }, entryType: 'REVERSAL' } }), 0);
        assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: control.order.id } }, entryType: 'REVERSAL' } }), 0);
      } finally {
        releaseLock();
        await Promise.allSettled([lockTransaction, capturePromise, cancelPromise].filter(Boolean));
      }
    }

    await runCancellationCaptureRace('cancel-before-capture', false);
    await runCancellationCaptureRace('capture-before-cancel', true);

    // Inject a failure after provider-event/payment work has begun but before
    // affiliate ledger completion. The enclosing transaction must roll back
    // every financial and audit write, allowing the same event to be retried.
    const stripeAffiliateCapture = await createAffiliateOrder('atomic-stripe-capture');
    const stripeAffiliateCaptureEvent = checkoutEvent(`evt_affiliate_atomicity_stripe_capture_${suffix}`, 'checkout.session.completed', stripeAffiliateCapture);
    const removeStripeCaptureFailure = await installAffiliateLedgerFailure();
    try {
      const failed = await deliverStripeEvent(stripeAffiliateCaptureEvent);
      assert.equal(failed.status, 500, `Injected Stripe affiliate failure should return retryable 500, got ${failed.status}: ${failed.body}`);
    } finally { await removeStripeCaptureFailure(); }
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: stripeAffiliateCapture.order.id } })).status, 'PENDING');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: stripeAffiliateCaptureEvent.id } }), 0);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: stripeAffiliateCapture.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: stripeAffiliateCapture.order.id } } } }), 0);
    assert.equal((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: stripeAffiliateCapture.click.id } })).convertedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: stripeAffiliateCapture.order.id } })).id } }), 0);
    await sendStripeEvent(stripeAffiliateCaptureEvent);
    await sendStripeEvent(stripeAffiliateCaptureEvent);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: stripeAffiliateCapture.order.id } })).status, 'PAID');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: stripeAffiliateCaptureEvent.id, reviewReason: null, parentOrderId: stripeAffiliateCapture.order.id } }), 1);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: stripeAffiliateCapture.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.deepEqual((await prisma.commissionLedger.findMany({ where: { orderItem: { sellerOrder: { parentId: stripeAffiliateCapture.order.id } }, entryType: 'EARNED' } })).map(row => [row.amountMinor, row.sourceEventId]), [[500, stripeAffiliateCaptureEvent.id]]);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: stripeAffiliateCapture.order.id } })).id } }), 1);

    // Exercise both supported PayPal payload shapes through the production event
    // normalizer and transactional reconciliation path (synthetic, no provider call).
    const paypalOrderCompletedFixture = await createAffiliateOrder('paypal-order-completed', { method: 'PAYPAL' });
    const sharedCaptureId = `cap_synthetic_${paypalOrderCompletedFixture.order.id}`;
    const orderCompletedPayload = paypalOrderCompletedPayload(`evt_paypal_order_completed_${suffix}`, paypalOrderCompletedFixture, { captureId: sharedCaptureId });
    const orderCompletedResult = await sendPaypalPayload(orderCompletedPayload);
    assert.equal(orderCompletedResult.event.captureConfirmed, true);
    assert.equal(orderCompletedResult.event.amountMinor, 10_000);
    assert.equal(orderCompletedResult.event.currency, 'USD');
    assert.equal(orderCompletedResult.result.reviewReason, null);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalOrderCompletedFixture.order.id } })).status, 'PAID');
    const orderCompletedSource = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'PAYPAL', eventId: orderCompletedPayload.id } } });
    assert.equal(orderCompletedSource.parentOrderId, paypalOrderCompletedFixture.order.id);
    assert.equal(orderCompletedSource.reviewReason, null);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalOrderCompletedFixture.order.id }, entryType: 'ACCRUAL', amountMinor: 1_000 } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalOrderCompletedFixture.order.id } }, entryType: 'EARNED', amountMinor: 500 } }), 1);
    const orderCompletedPayment = await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalOrderCompletedFixture.order.id } });
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: orderCompletedPayment.id } }), 1);

    // Replaying the same event and reporting the same capture through the
    // capture event type cannot repeat any payment or ledger side effect.
    await sendPaypalPayload(orderCompletedPayload);
    const duplicateCapturePayload = paypalCaptureCompletedPayload(`evt_paypal_capture_same_${suffix}`, paypalOrderCompletedFixture, { captureId: sharedCaptureId });
    const duplicateCaptureResult = await sendPaypalPayload(duplicateCapturePayload);
    assert.equal(duplicateCaptureResult.result.becamePaid, false);
    assert.equal(duplicateCaptureResult.result.reviewReason, null);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalOrderCompletedFixture.order.id } })).status, 'PAID');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'PAYPAL', parentOrderId: paypalOrderCompletedFixture.order.id, reviewReason: null, eventType: { in: ['CHECKOUT.ORDER.COMPLETED', 'PAYMENT.CAPTURE.COMPLETED'] } } }), 2);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalOrderCompletedFixture.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalOrderCompletedFixture.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: orderCompletedPayment.id } }), 1);
    assert.ok((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: paypalOrderCompletedFixture.click.id } })).convertedAt);

    const paypalDirectCapture = await createAffiliateOrder('paypal-direct-capture-payload', { method: 'PAYPAL' });
    const directCaptureResult = await sendPaypalPayload(paypalCaptureCompletedPayload(`evt_paypal_capture_payload_${suffix}`, paypalDirectCapture));
    assert.equal(directCaptureResult.event.captureConfirmed, true);
    assert.equal(directCaptureResult.result.reviewReason, null);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalDirectCapture.order.id } })).status, 'PAID');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalDirectCapture.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalDirectCapture.order.id } }, entryType: 'EARNED' } }), 1);

    const paypalOrderWithoutCapture = await createAffiliateOrder('paypal-order-no-capture', { method: 'PAYPAL' });
    const noCapturePayload = paypalOrderCompletedPayload(`evt_paypal_order_no_capture_${suffix}`, paypalOrderWithoutCapture, { captures: [] });
    const noCaptureResult = await sendPaypalPayload(noCapturePayload);
    assert.equal(noCaptureResult.event.captureConfirmed, false);
    assert.equal(noCaptureResult.result.reviewReason, 'PAYMENT_CAPTURE_NOT_CONFIRMED');
    const noCaptureSource = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'PAYPAL', eventId: noCapturePayload.id } } });
    assert.equal(noCaptureSource.parentOrderId, paypalOrderWithoutCapture.order.id);
    assert.equal(noCaptureSource.reviewReason, 'PAYMENT_CAPTURE_NOT_CONFIRMED');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalOrderWithoutCapture.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalOrderWithoutCapture.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalOrderWithoutCapture.order.id } } } }), 0);

    const paypalUncompletedCapture = await createAffiliateOrder('paypal-order-incomplete-capture', { method: 'PAYPAL' });
    const incompletePayload = paypalOrderCompletedPayload(`evt_paypal_order_incomplete_capture_${suffix}`, paypalUncompletedCapture, { captureStatus: 'PENDING' });
    const incompleteResult = await sendPaypalPayload(incompletePayload);
    assert.equal(incompleteResult.event.captureConfirmed, false);
    assert.equal(incompleteResult.result.reviewReason, 'PAYMENT_CAPTURE_NOT_CONFIRMED');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalUncompletedCapture.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalUncompletedCapture.order.id } } }), 0);

    const paypalMismatchedAssociation = await createAffiliateOrder('paypal-order-mismatched-association', { method: 'PAYPAL' });
    const mismatchPayload = paypalOrderCompletedPayload(`evt_paypal_order_wrong_association_${suffix}`, paypalMismatchedAssociation, { customId: `other-order-${suffix}`, referenceId: `other-order-${suffix}` });
    const mismatchResult = await sendPaypalPayload(mismatchPayload);
    assert.equal(mismatchResult.result.reviewReason, 'ORDER_PAYMENT_REFERENCE_MISMATCH');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalMismatchedAssociation.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalMismatchedAssociation.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalMismatchedAssociation.order.id } } } }), 0);

    const paypalWrongCurrency = await createAffiliateOrder('paypal-order-wrong-currency', { method: 'PAYPAL' });
    const wrongCurrencyPayload = paypalOrderCompletedPayload(`evt_paypal_order_wrong_currency_${suffix}`, paypalWrongCurrency, { currency: 'EUR' });
    const wrongCurrencyResult = await sendPaypalPayload(wrongCurrencyPayload);
    assert.equal(wrongCurrencyResult.event.captureConfirmed, true);
    assert.equal(wrongCurrencyResult.result.reviewReason, 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalWrongCurrency.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalWrongCurrency.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalWrongCurrency.order.id } } } }), 0);

    const paypalWrongAmount = await createAffiliateOrder('paypal-order-wrong-amount', { method: 'PAYPAL' });
    const wrongAmountPayload = paypalOrderCompletedPayload(`evt_paypal_order_wrong_amount_${suffix}`, paypalWrongAmount, { amount: '99.99' });
    const wrongAmountResult = await sendPaypalPayload(wrongAmountPayload);
    assert.equal(wrongAmountResult.event.captureConfirmed, true);
    assert.equal(wrongAmountResult.result.reviewReason, 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalWrongAmount.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalWrongAmount.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalWrongAmount.order.id } } } }), 0);

    // Existing failure injection still verifies that the same transaction path
    // rolls back before reporting success when affiliate ledger work fails.
    const paypalAffiliateCapture = await createAffiliateOrder('atomic-paypal-capture', { method: 'PAYPAL' });
    const paypalAffiliateCaptureEvent = {
      provider: 'PAYPAL', eventId: `evt_affiliate_atomicity_paypal_capture_${suffix}`, eventType: 'PAYMENT.CAPTURE.COMPLETED',
      providerObjectRef: paypalAffiliateCapture.paypalOrderId, paymentLookupRef: paypalAffiliateCapture.paypalOrderId,
      amountMinor: 10_000, currency: 'USD', occurredAt: new Date(), captureConfirmed: true
    };
    const removePaypalCaptureFailure = await installAffiliateLedgerFailure();
    try { await assert.rejects(sendVerifiedPaypal(paypalAffiliateCaptureEvent)); }
    finally { await removePaypalCaptureFailure(); }
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalAffiliateCapture.order.id } })).status, 'PENDING');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'PAYPAL', eventId: paypalAffiliateCaptureEvent.eventId } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalAffiliateCapture.order.id } } } }), 0);
    await sendVerifiedPaypal(paypalAffiliateCaptureEvent);
    await sendVerifiedPaypal(paypalAffiliateCaptureEvent);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalAffiliateCapture.order.id } })).status, 'PAID');
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'PAYPAL', eventId: paypalAffiliateCaptureEvent.eventId, reviewReason: null } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalAffiliateCapture.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalAffiliateCapture.order.id } })).id } }), 1);

    const stripeAffiliateRefund = await createAffiliateOrder('atomic-stripe-refund');
    const stripeAffiliateRefundCapture = checkoutEvent(`evt_affiliate_atomicity_stripe_refund_capture_${suffix}`, 'checkout.session.completed', stripeAffiliateRefund);
    await sendStripeEvent(stripeAffiliateRefundCapture);
    const stripeAffiliateRefundEvent = refundEvent(`evt_affiliate_atomicity_stripe_refund_${suffix}`, stripeAffiliateRefund, 2_000);
    const stripeRefundAuditCountBefore = await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED' } });
    const removeStripeRefundFailure = await installAffiliateLedgerFailure();
    try {
      const failed = await deliverStripeEvent(stripeAffiliateRefundEvent);
      assert.equal(failed.status, 500, `Injected Stripe refund failure should return retryable 500, got ${failed.status}: ${failed.body}`);
    } finally { await removeStripeRefundFailure(); }
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: stripeAffiliateRefundEvent.id } }), 0);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { provider: 'STRIPE', providerEventId: stripeAffiliateRefundEvent.id } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: stripeAffiliateRefund.order.id } }, entryType: 'REVERSAL' } }), 0);
    assert.equal(await prisma.affiliateAdjustment.count({ where: { orderId: stripeAffiliateRefund.order.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED' } }), stripeRefundAuditCountBefore);
    await sendStripeEvent(stripeAffiliateRefundEvent);
    await sendStripeEvent(stripeAffiliateRefundEvent);
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: stripeAffiliateRefundEvent.id, reviewReason: null } }), 1);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { provider: 'STRIPE', providerEventId: stripeAffiliateRefundEvent.id } }), 1);
    assert.deepEqual((await prisma.commissionLedger.findMany({ where: { orderItem: { sellerOrder: { parentId: stripeAffiliateRefund.order.id } } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['EARNED', 500], ['REVERSAL', -100]]);
    assert.equal(await prisma.affiliateAdjustment.count({ where: { orderId: stripeAffiliateRefund.order.id, providerEventId: stripeAffiliateRefundEvent.id, amountMinor: 100 } }), 1);
    const stripeReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: stripeAffiliateRefundEvent.id } } });
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED', entityId: stripeReview.id } }), 1);

    const paypalAffiliateRefund = await createAffiliateOrder('atomic-paypal-refund', { method: 'PAYPAL' });
    const paypalAffiliateRefundCapture = {
      provider: 'PAYPAL', eventId: `evt_affiliate_atomicity_paypal_refund_capture_${suffix}`, eventType: 'PAYMENT.CAPTURE.COMPLETED',
      providerObjectRef: paypalAffiliateRefund.paypalOrderId, paymentLookupRef: paypalAffiliateRefund.paypalOrderId,
      amountMinor: 10_000, currency: 'USD', occurredAt: new Date(), captureConfirmed: true
    };
    await sendVerifiedPaypal(paypalAffiliateRefundCapture);
    const paypalAffiliateRefundEvent = {
      provider: 'PAYPAL', eventId: `evt_affiliate_atomicity_paypal_refund_${suffix}`, eventType: 'PAYMENT.CAPTURE.REFUNDED',
      providerObjectRef: paypalAffiliateRefund.paypalOrderId, paymentLookupRef: paypalAffiliateRefund.paypalOrderId,
      amountMinor: 2_000, currency: 'USD', occurredAt: new Date()
    };
    const paypalRefundAuditCountBefore = await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED' } });
    const removePaypalRefundFailure = await installAffiliateLedgerFailure();
    try { await assert.rejects(sendVerifiedPaypal(paypalAffiliateRefundEvent)); }
    finally { await removePaypalRefundFailure(); }
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'PAYPAL', eventId: paypalAffiliateRefundEvent.eventId } }), 0);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { provider: 'PAYPAL', providerEventId: paypalAffiliateRefundEvent.eventId } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: paypalAffiliateRefund.order.id } }, entryType: 'REVERSAL' } }), 0);
    assert.equal(await prisma.affiliateAdjustment.count({ where: { orderId: paypalAffiliateRefund.order.id } }), 0);
    await sendVerifiedPaypal(paypalAffiliateRefundEvent);
    await sendVerifiedPaypal(paypalAffiliateRefundEvent);
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'PAYPAL', eventId: paypalAffiliateRefundEvent.eventId, reviewReason: null } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED' } }), paypalRefundAuditCountBefore + 1);
    const paypalAtomicReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: paypalAffiliateRefundEvent.eventId } } });
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_CREATED', entityId: paypalAtomicReview.id } }), 1);
    assert.deepEqual((await prisma.commissionLedger.findMany({ where: { orderItem: { sellerOrder: { parentId: paypalAffiliateRefund.order.id } } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['EARNED', 500], ['REVERSAL', -100]]);
    assert.equal(await prisma.affiliateAdjustment.count({ where: { orderId: paypalAffiliateRefund.order.id, providerEventId: paypalAffiliateRefundEvent.eventId, amountMinor: 100 } }), 1);

    // First delivery is unassociated; replay after the local Checkout Session
    // reference appears must resume this same event, not short-circuit as duplicate.
    const lateReference = await createAffiliateOrder('capture-after-reference', { unassociatedPaymentReference: true });
    const lateReferenceCapture = checkoutEvent(`evt_capture_after_reference_${suffix}`, 'checkout.session.completed', lateReference);
    await sendStripeEvent(lateReferenceCapture);
    const unresolvedCapture = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: lateReferenceCapture.id } } });
    assert.equal(unresolvedCapture.parentOrderId, null);
    assert.equal(unresolvedCapture.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: lateReference.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: lateReference.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: lateReference.order.id } } } }), 0);
    await prisma.payment.update({ where: { parentId: lateReference.order.id }, data: { providerRef: lateReference.sessionId } });
    const changedLookupReplay = structuredClone(lateReferenceCapture);
    changedLookupReplay.data.object.id = `cs_wrong_lookup_${suffix}`;
    assert.equal((await deliverStripeEvent(changedLookupReplay)).status, 500, 'A replay with the same event ID but a different payment lookup reference is rejected.');
    const changedCaptureReplay = structuredClone(lateReferenceCapture);
    changedCaptureReplay.data.object.payment_status = 'unpaid';
    assert.equal((await deliverStripeEvent(changedCaptureReplay)).status, 500, 'A replay with the same event ID but a different capture assertion is rejected.');
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: unresolvedCapture.id } })).reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    await sendStripeEvent(lateReferenceCapture);
    await sendStripeEvent(lateReferenceCapture);
    const reconciledCapture = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: unresolvedCapture.id } });
    assert.equal(reconciledCapture.parentOrderId, lateReference.order.id);
    assert.equal(reconciledCapture.reviewReason, null);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: lateReference.order.id } })).status, 'PAID');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: lateReference.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: lateReference.order.id } }, entryType: 'EARNED' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: (await prisma.payment.findUniqueOrThrow({ where: { parentId: lateReference.order.id } })).id } }), 1);

    const paid = await createOrder('paid');
    const captured = checkoutEvent(`evt_synthetic_capture_${suffix}`, 'checkout.session.completed', paid);
    await sendStripeEvent(captured);
    await sendStripeEvent(captured);
    const paidPayment = await prisma.payment.findUniqueOrThrow({ where: { parentId: paid.order.id } });
    assert.equal(paidPayment.status, 'PAID');
    assert.equal(paidPayment.providerRef, paid.paymentIntentId);
    const initialLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: paid.order.id } } });
    assert.equal(initialLedger.length, 1);
    assert.deepEqual({ entryType: initialLedger[0].entryType, amountMinor: initialLedger[0].amountMinor, eligibleBaseMinor: initialLedger[0].eligibleBaseMinor, currency: initialLedger[0].currency, policyVersionId: initialLedger[0].policyVersionId }, {
      entryType: 'ACCRUAL', amountMinor: 1_000, eligibleBaseMinor: 10_000, currency: 'USD', policyVersionId: policy.id
    });
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: captured.id } }), 1);

    const failed = await createOrder('failed');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_failed_${suffix}`, 'checkout.session.async_payment_failed', failed, 'unpaid'));
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: failed.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: failed.order.id } } }), 0);

    const uncaptured = await createOrder('uncaptured');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_uncaptured_${suffix}`, 'checkout.session.completed', uncaptured, 'unpaid'));
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: uncaptured.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: uncaptured.order.id } } }), 0);

    // A persisted event is not enough by itself: the resolver requires a clean,
    // supported refund/dispute event bound to this exact provider and order.
    const invalidSourceOrder = await createOrder('invalid-refund-source', { knownPaymentIntentReference: true });
    const invalidSourceEventId = `evt_synthetic_invalid_refund_source_${suffix}`;
    const invalidSourceReview = await prisma.sellerCommissionReviewEvent.create({ data: {
      parentOrderId: invalidSourceOrder.order.id, provider: 'STRIPE', providerEventId: invalidSourceEventId,
      amountMinor: 1_000, currency: 'USD', idempotencyKey: `review-invalid-source-${suffix}`, reason: 'Synthetic invalid source-event rejection'
    } });
    await prisma.processedWebhookEvent.create({ data: {
      provider: 'STRIPE', eventId: invalidSourceEventId, eventType: 'checkout.session.completed',
      parentOrderId: invalidSourceOrder.order.id, amountMinor: 10_000, currency: 'USD'
    } });
    const invalidSourceResult = await resolveRefund(invalidSourceReview, invalidSourceOrder.order.sellerOrders[0].items[0].id, 1_000);
    assert.equal(invalidSourceResult.status, 409, JSON.stringify(invalidSourceResult.body));
    assert.equal(invalidSourceResult.body.code, 'COMMISSION_REFUND_EVENT_MISSING');
    assert.equal((await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: invalidSourceReview.id } })).status, 'NEEDS_ALLOCATION');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: invalidSourceOrder.order.id } } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { actorId: admin.id, action: 'SELLER_COMMISSION_REFUND_ALLOCATION_POSTED', entityId: invalidSourceReview.id } }), 0);

    const crossOrderEventId = `evt_synthetic_cross_order_refund_${suffix}`;
    const crossTargetOrder = await createOrder('cross-order-target');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_cross_target_capture_${suffix}`, 'checkout.session.completed', crossTargetOrder));
    const crossOrderReview = await prisma.sellerCommissionReviewEvent.create({ data: {
      parentOrderId: crossTargetOrder.order.id, provider: 'STRIPE', providerEventId: crossOrderEventId,
      amountMinor: 1_000, currency: 'USD', idempotencyKey: `review-cross-order-${suffix}`, reason: 'Synthetic cross-order source rejection'
    } });
    const foreignSourceOrder = await createOrder('foreign-refund-source');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_foreign_capture_${suffix}`, 'checkout.session.completed', foreignSourceOrder));
    const foreignSourceEvent = await prisma.processedWebhookEvent.create({ data: {
      provider: 'STRIPE', eventId: crossOrderEventId, eventType: 'charge.refunded',
      parentOrderId: foreignSourceOrder.order.id, amountMinor: 1_000, currency: 'USD',
      providerObjectRef: foreignSourceOrder.paymentIntentId, providerTotalMinor: 10_000
    } });
    const beforeCrossTargetLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: crossTargetOrder.order.id } }, orderBy: { id: 'asc' } });
    const beforeForeignLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: foreignSourceOrder.order.id } }, orderBy: { id: 'asc' } });
    assert.equal(beforeCrossTargetLedger.length, 1, 'target begins with a real accrual');
    assert.equal(beforeForeignLedger.length, 1, 'foreign source begins with a real accrual');
    const beforeCrossReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: crossOrderReview.id } });
    const auditedEntities = [crossOrderReview.id, crossTargetOrder.order.id, foreignSourceOrder.order.id, crossOrderEventId];
    const beforeCrossAudits = await prisma.auditLog.findMany({ where: { entityId: { in: auditedEntities } }, orderBy: { id: 'asc' } });
    const beforeSourceEvent = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: crossOrderEventId } } });
    const crossOrderResult = await resolveRefund(crossOrderReview, crossTargetOrder.order.sellerOrders[0].items[0].id, 1_000);
    assert.equal(crossOrderResult.status, 409, JSON.stringify(crossOrderResult.body));
    assert.equal(crossOrderResult.body.code, 'COMMISSION_REFUND_EVENT_MISSING');
    assert.deepEqual(await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: crossOrderReview.id } }), beforeCrossReview);
    assert.deepEqual(await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: crossTargetOrder.order.id } }, orderBy: { id: 'asc' } }), beforeCrossTargetLedger);
    assert.deepEqual(await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: foreignSourceOrder.order.id } }, orderBy: { id: 'asc' } }), beforeForeignLedger);
    assert.deepEqual(await prisma.auditLog.findMany({ where: { entityId: { in: auditedEntities } }, orderBy: { id: 'asc' } }), beforeCrossAudits);
    assert.deepEqual(await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: foreignSourceEvent.id } }), beforeSourceEvent);
    assert.equal(await prisma.processedWebhookEvent.count({ where: { provider: 'STRIPE', eventId: crossOrderEventId } }), 1);

    // Match the real checkout state: only the Checkout Session is saved until
    // the capture webhook reveals and binds the PaymentIntent.
    const beforeCapture = await createOrder('refund-before-capture');
    const preCaptureRefund = refundEvent(`evt_synthetic_partial_refund_before_capture_${suffix}`, beforeCapture, 2_000);
    await sendStripeEvent(preCaptureRefund);
    await sendStripeEvent(preCaptureRefund);
    const pendingStripeRefund = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: preCaptureRefund.id } } });
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: beforeCapture.order.id } })).providerRef, beforeCapture.sessionId);
    assert.equal(pendingStripeRefund.parentOrderId, null);
    assert.equal(pendingStripeRefund.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: beforeCapture.order.id } }), 0);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: beforeCapture.order.id } } }), 0);
    const preCaptureItemId = beforeCapture.order.sellerOrders[0].items[0].id;

    const captureAfterRefund = checkoutEvent(`evt_synthetic_capture_after_refund_${suffix}`, 'checkout.session.completed', beforeCapture);
    await sendStripeEvent(captureAfterRefund);
    await sendStripeEvent(captureAfterRefund);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: beforeCapture.order.id } })).status, 'PAID');
    const preCaptureReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: preCaptureRefund.id } } });
    const boundStripeRefund = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: preCaptureRefund.id } } });
    assert.equal(boundStripeRefund.parentOrderId, beforeCapture.order.id);
    assert.equal(boundStripeRefund.reviewReason, null);
    assert.equal(preCaptureReview.amountMinor, 2_000);
    assert.equal(preCaptureReview.status, 'NEEDS_ALLOCATION');
    const postCaptureAccruals = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: beforeCapture.order.id } } });
    assert.equal(postCaptureAccruals.length, 1);
    assert.equal(postCaptureAccruals[0].entryType, 'ACCRUAL');
    assert.equal(postCaptureAccruals[0].amountMinor, 1_000);

    const resolved = await resolveRefund(preCaptureReview, preCaptureItemId, 2_000);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const duplicateResolution = await resolveRefund(preCaptureReview, preCaptureItemId, 2_000);
    assert.equal(duplicateResolution.status, 404, JSON.stringify(duplicateResolution.body));
    await sendStripeEvent(preCaptureRefund);
    const postedReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: preCaptureReview.id } });
    assert.equal(postedReview.status, 'POSTED');
    assert.deepEqual(postedReview.allocationJson, [{ orderItemId: preCaptureItemId, refundMinor: 2_000 }]);
    const refundLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: beforeCapture.order.id } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(refundLedger.map(entry => entry.amountMinor), [1_000, -200]);
    assert.equal(refundLedger[1].entryType, 'REVERSAL');
    assert.equal(refundLedger[1].eligibleBaseMinor, 2_000);
    assert.equal(refundLedger[1].reversalOfId, refundLedger[0].id);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: beforeCapture.order.id }, entryType: 'REVERSAL' } }), 1);
    const allocationAudits = await prisma.auditLog.findMany({ where: { actorId: admin.id, action: 'SELLER_COMMISSION_REFUND_ALLOCATION_POSTED', entityId: preCaptureReview.id } });
    assert.equal(allocationAudits.length, 1);
    assert.deepEqual(allocationAudits[0].metadata, { allocations: [{ orderItemId: preCaptureItemId, refundMinor: 2_000 }], reason: 'Synthetic verified refund allocation' });

    const conflictingMetadataOrder = await createOrder('conflicting-metadata-refund');
    const conflictingMetadataRefund = refundEvent(`evt_synthetic_conflicting_metadata_refund_${suffix}`, conflictingMetadataOrder, 2_000);
    conflictingMetadataRefund.data.object.metadata = { orderId: foreignSourceOrder.order.id };
    await sendStripeEvent(conflictingMetadataRefund);
    await sendStripeEvent(checkoutEvent(`evt_synthetic_conflicting_metadata_capture_${suffix}`, 'checkout.session.completed', conflictingMetadataOrder));
    const heldConflict = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: conflictingMetadataRefund.id } } });
    assert.equal(heldConflict.parentOrderId, null);
    assert.equal(heldConflict.reviewReason, 'ORDER_PAYMENT_REFERENCE_MISMATCH');
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: conflictingMetadataOrder.order.id } }), 0);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: foreignSourceOrder.order.id } }), 0);

    const unlinkedChargeOrder = await createOrder('charge-without-payment-intent');
    const unlinkedChargeRefund = refundEvent(`evt_synthetic_charge_without_pi_${suffix}`, unlinkedChargeOrder, 1_000);
    delete unlinkedChargeRefund.data.object.payment_intent;
    unlinkedChargeRefund.data.object.metadata = { orderId: unlinkedChargeOrder.order.id };
    await sendStripeEvent(unlinkedChargeRefund);
    const unlinkedEvent = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: unlinkedChargeRefund.id } } });
    assert.equal(unlinkedEvent.providerObjectRef, `ch_synthetic_${unlinkedChargeOrder.order.id}`);
    assert.equal(unlinkedEvent.metadataOrderId, unlinkedChargeOrder.order.id);
    assert.equal(unlinkedEvent.parentOrderId, null, 'metadata alone must not bind a Charge to an order');
    assert.equal(unlinkedEvent.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_unlinked_charge_capture_${suffix}`, 'checkout.session.completed', unlinkedChargeOrder));
    const stillUnlinked = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: unlinkedEvent.id } });
    assert.equal(stillUnlinked.parentOrderId, null);
    assert.equal(stillUnlinked.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: unlinkedChargeOrder.order.id } }), 0);
    const unresolvedResponse = await fetch(`${baseUrl}/api/admin/seller-commission-webhook-events`, { headers: { cookie: `marketplace_session=${sessionToken}` } });
    assert.equal(unresolvedResponse.status, 200);
    assert.ok((await unresolvedResponse.json()).some(row => row.eventId === unlinkedChargeRefund.id && row.reviewReason === 'AWAITING_CAPTURE_ASSOCIATION'));

    const fullRefundBeforeCapture = await createOrder('full-refund-before-capture');
    const earlyFullRefund = refundEvent(`evt_synthetic_full_refund_before_capture_${suffix}`, fullRefundBeforeCapture, 10_000);
    await sendStripeEvent(earlyFullRefund);
    await sendStripeEvent(earlyFullRefund);
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: earlyFullRefund.id } } })).reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_capture_after_full_refund_${suffix}`, 'checkout.session.completed', fullRefundBeforeCapture));
    const fullRefundPayment = await prisma.payment.findUniqueOrThrow({ where: { parentId: fullRefundBeforeCapture.order.id } });
    assert.equal(fullRefundPayment.status, 'REFUNDED');
    const fullRefundLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: fullRefundBeforeCapture.order.id } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(fullRefundLedger.map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);
    const boundFullRefund = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: earlyFullRefund.id } } });
    assert.equal(boundFullRefund.parentOrderId, fullRefundBeforeCapture.order.id);
    assert.equal(boundFullRefund.reviewReason, null);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: fullRefundBeforeCapture.order.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_FULL_REFUND_RECONCILED', entityId: fullRefundBeforeCapture.order.id } }), 1);

    const disputeBeforeCapture = await createOrder('full-dispute-before-capture');
    const earlyDispute = disputeEvent(`evt_synthetic_dispute_before_capture_${suffix}`, disputeBeforeCapture, 10_000);
    await sendStripeEvent(earlyDispute);
    await sendStripeEvent(earlyDispute);
    assert.equal((await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: earlyDispute.id } } })).reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_capture_after_dispute_${suffix}`, 'checkout.session.completed', disputeBeforeCapture));
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: disputeBeforeCapture.order.id } })).status, 'DISPUTED');
    assert.deepEqual((await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: disputeBeforeCapture.order.id } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);
    const boundDispute = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: earlyDispute.id } } });
    assert.equal(boundDispute.parentOrderId, disputeBeforeCapture.order.id);
    assert.equal(boundDispute.reviewReason, null);

    const cumulativeBeforeCapture = await createOrder('cumulative-refunds-before-capture');
    const providerTime = Math.floor(Date.now() / 1_000);
    const newerCumulative = refundEvent(`evt_synthetic_cumulative_4000_${suffix}`, cumulativeBeforeCapture, 4_000, providerTime + 2);
    const olderCumulative = refundEvent(`evt_synthetic_cumulative_2000_${suffix}`, cumulativeBeforeCapture, 2_000, providerTime + 1);
    await sendStripeEvent(newerCumulative);
    await sendStripeEvent(olderCumulative);
    await sendStripeEvent(checkoutEvent(`evt_synthetic_cumulative_capture_${suffix}`, 'checkout.session.completed', cumulativeBeforeCapture, 'paid', providerTime + 3));
    await sendStripeEvent(newerCumulative);
    await sendStripeEvent(olderCumulative);
    const cumulativeReviews = await prisma.sellerCommissionReviewEvent.findMany({ where: { parentOrderId: cumulativeBeforeCapture.order.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(cumulativeReviews.map(row => row.amountMinor), [2_000, 2_000]);
    assert.equal(cumulativeReviews.every(row => row.status === 'NEEDS_ALLOCATION'), true);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: cumulativeBeforeCapture.order.id }, entryType: 'ACCRUAL' } }), 1);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: cumulativeBeforeCapture.order.id }, entryType: 'REVERSAL' } }), 0);

    const supersededByRefund = await createOrder('partial-review-superseded-by-full-refund');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_supersede_refund_capture_${suffix}`, 'checkout.session.completed', supersededByRefund));
    const partialToSupersede = refundEvent(`evt_synthetic_superseded_partial_refund_${suffix}`, supersededByRefund, 2_000);
    await sendStripeEvent(partialToSupersede);
    const partialReviewToSupersede = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: partialToSupersede.id } } });
    const fullAfterPartial = refundEvent(`evt_synthetic_full_after_partial_${suffix}`, supersededByRefund, 10_000);
    await sendStripeEvent(fullAfterPartial);
    await sendStripeEvent(fullAfterPartial);
    const supersededRefundReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: partialReviewToSupersede.id } });
    assert.equal(supersededRefundReview.status, 'IGNORED');
    assert.match(supersededRefundReview.resolutionReason, /full refund/i);
    assert.ok(supersededRefundReview.reviewedAt);
    assert.equal(supersededRefundReview.reviewedById, null);
    assert.deepEqual((await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: supersededByRefund.order.id } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_SUPERSEDED', entityId: partialReviewToSupersede.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_FULL_REFUND_RECONCILED', entityId: supersededByRefund.order.id } }), 1);

    const supersededByDispute = await createOrder('partial-review-superseded-by-dispute');
    await sendStripeEvent(checkoutEvent(`evt_synthetic_supersede_dispute_capture_${suffix}`, 'checkout.session.completed', supersededByDispute));
    const partialDispute = disputeEvent(`evt_synthetic_partial_dispute_${suffix}`, supersededByDispute, 2_000);
    await sendStripeEvent(partialDispute);
    const partialDisputeReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: partialDispute.id } } });
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: supersededByDispute.order.id } })).status, 'DISPUTED');
    const fullDispute = disputeEvent(`evt_synthetic_full_dispute_${suffix}`, supersededByDispute, 10_000);
    await sendStripeEvent(fullDispute);
    await sendStripeEvent(fullDispute);
    const terminalDisputeReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: partialDisputeReview.id } });
    assert.equal(terminalDisputeReview.status, 'IGNORED');
    assert.match(terminalDisputeReview.resolutionReason, /chargeback/i);
    assert.equal(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_REVIEW_SUPERSEDED', entityId: partialDisputeReview.id } }), 1);
    assert.deepEqual((await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: supersededByDispute.order.id } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);

    const paypalPartial = await createOrder('paypal-partial-before-capture', { method: 'PAYPAL' });
    const paypalPartialEvent = {
      provider: 'PAYPAL', eventId: `evt_synthetic_paypal_partial_before_capture_${suffix}`, eventType: 'PAYMENT.CAPTURE.REFUNDED',
      providerObjectRef: paypalPartial.paypalOrderId, paymentLookupRef: paypalPartial.paypalOrderId,
      amountMinor: 2_000, currency: 'USD', occurredAt: new Date()
    };
    await sendVerifiedPaypal(paypalPartialEvent);
    await sendVerifiedPaypal(paypalPartialEvent);
    const paypalPending = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'PAYPAL', eventId: paypalPartialEvent.eventId } } });
    assert.equal(paypalPending.parentOrderId, paypalPartial.order.id);
    assert.equal(paypalPending.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: paypalPartial.order.id } }), 0);
    await sendVerifiedPaypal({
      provider: 'PAYPAL', eventId: `evt_synthetic_paypal_capture_partial_${suffix}`, eventType: 'PAYMENT.CAPTURE.COMPLETED',
      providerObjectRef: paypalPartial.paypalOrderId, paymentLookupRef: paypalPartial.paypalOrderId,
      amountMinor: 10_000, currency: 'USD', occurredAt: new Date(Date.now() + 1_000), captureConfirmed: true
    });
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalPartial.order.id } })).status, 'PAID');
    const paypalReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: paypalPartialEvent.eventId } } });
    assert.equal(paypalReview.amountMinor, 2_000);
    const paypalPartialLedger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: paypalPartial.order.id } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(paypalPartialLedger.map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000]]);
    const paypalPartialResolution = await resolveRefund(paypalReview, paypalPartial.order.sellerOrders[0].items[0].id, 2_000);
    assert.equal(paypalPartialResolution.status, 200, JSON.stringify(paypalPartialResolution.body));
    await sendVerifiedPaypal(paypalPartialEvent);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: paypalPartial.order.id }, entryType: 'REVERSAL' } }), 1);

    const paypalDispute = await createOrder('paypal-dispute-before-capture', { method: 'PAYPAL' });
    const paypalDisputeEvent = {
      provider: 'PAYPAL', eventId: `evt_synthetic_paypal_dispute_before_capture_${suffix}`, eventType: 'CUSTOMER.DISPUTE.CREATED',
      providerObjectRef: paypalDispute.paypalOrderId, paymentLookupRef: paypalDispute.paypalOrderId,
      amountMinor: 10_000, currency: 'USD', occurredAt: new Date()
    };
    await sendVerifiedPaypal(paypalDisputeEvent);
    await sendVerifiedPaypal({
      provider: 'PAYPAL', eventId: `evt_synthetic_paypal_capture_dispute_${suffix}`, eventType: 'PAYMENT.CAPTURE.COMPLETED',
      providerObjectRef: paypalDispute.paypalOrderId, paymentLookupRef: paypalDispute.paypalOrderId,
      amountMinor: 10_000, currency: 'USD', occurredAt: new Date(Date.now() + 1_000), captureConfirmed: true
    });
    await sendVerifiedPaypal(paypalDisputeEvent);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paypalDispute.order.id } })).status, 'DISPUTED');
    assert.deepEqual((await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: paypalDispute.order.id } }, orderBy: { createdAt: 'asc' } })).map(row => [row.entryType, row.amountMinor]), [['ACCRUAL', 1_000], ['REVERSAL', -1_000]]);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: paypalDispute.order.id } }), 0);

    const zeroCommission = await createOrder('zero-commission', { zeroCommission: true });
    await sendStripeEvent(checkoutEvent(`evt_synthetic_zero_capture_${suffix}`, 'checkout.session.completed', zeroCommission));
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: zeroCommission.order.id } } }), 0);
    const zeroRefund = refundEvent(`evt_synthetic_zero_refund_${suffix}`, zeroCommission, 1_000);
    await sendStripeEvent(zeroRefund);
    const zeroReview = await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: zeroRefund.id } } });
    const zeroResolution = await resolveRefund(zeroReview, zeroCommission.order.sellerOrders[0].items[0].id, 1_000);
    assert.equal(zeroResolution.status, 200, JSON.stringify(zeroResolution.body));
    assert.equal((await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: zeroReview.id } })).status, 'POSTED');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: zeroCommission.order.id } } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { actorId: admin.id, action: 'SELLER_COMMISSION_REFUND_ALLOCATION_POSTED', entityId: zeroReview.id } }), 1);

    const partialRefund = refundEvent(`evt_synthetic_partial_refund_${suffix}`, paid, 2_000);
    await sendStripeEvent(partialRefund);
    const review = await prisma.sellerCommissionReviewEvent.findUnique({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: partialRefund.id } } });
    assert.ok(review, 'verified partial refund must create an allocation review');
    assert.equal(review.amountMinor, 2_000);
    assert.equal(review.status, 'NEEDS_ALLOCATION');
    await prisma.$transaction(tx => allocatePartialRefund(tx, {
      parentOrderId: paid.order.id, reviewEventId: review.id, actorId: admin.id,
      allocations: [{ orderItemId: paid.order.sellerOrders[0].items[0].id, refundMinor: 2_000 }]
    }));
    await sendStripeEvent(partialRefund);
    let ledger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: paid.order.id } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(ledger.map(entry => entry.amountMinor), [1_000, -200]);
    assert.equal(ledger.reduce((sum, entry) => sum + entry.amountMinor, 0), 800);
    assert.equal(await prisma.sellerCommissionReviewEvent.count({ where: { parentOrderId: paid.order.id } }), 1);

    const finalRefund = refundEvent(`evt_synthetic_final_refund_${suffix}`, paid, 10_000);
    await sendStripeEvent(finalRefund);
    await sendStripeEvent(finalRefund);
    ledger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: paid.order.id } }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(ledger.map(entry => entry.amountMinor), [1_000, -200, -800]);
    assert.equal(ledger.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: paid.order.id } })).status, 'REFUNDED');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
