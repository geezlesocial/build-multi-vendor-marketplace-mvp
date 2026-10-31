import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';
import { createTestPrismaClient } from './prisma-test-client.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required for the guarded webhook migration regression.');
const { databaseName } = validateE2EDatabaseURL(databaseUrl);
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID ?? '';
const identity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(databaseName)?.[1];
if (!identity || identity !== sandboxId) throw new Error('Webhook migration regression requires a matching unique wallet_funding_e2e_<id> target.');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const sourcePrismaDir = path.join(rootDir, 'apps', 'api', 'prisma');
const prismaCli = [
  path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js'),
  path.join(rootDir, 'apps', 'api', 'node_modules', 'prisma', 'build', 'index.js')
].find(candidate => existsSync(candidate));
if (!prismaCli) throw new Error('Local Prisma CLI was not found; refusing to download dependencies for the migration regression.');

const isolatedDotenvPath = path.join(os.tmpdir(), `marketplace-no-dotenv-${identity}`);
if (existsSync(isolatedDotenvPath)) throw new Error('The isolated dotenv path unexpectedly exists; refusing to load environment files.');
process.env.DOTENV_CONFIG_PATH = isolatedDotenvPath;
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.PASSWORD_PEPPER = 'synthetic-webhook-upgrade-test-pepper';
process.env.AFFILIATE_DEFAULT_BASIS_POINTS = '500';
process.env.WALLET_FUNDING_SANDBOX_ID = identity;
process.env.MONEY_MOVEMENT_HARD_DISABLED = 'true';
process.env.WALLET_FUNDING_SANDBOX_MODE = 'false';
process.env.WALLET_FUNDING_PROVIDER_READY = 'false';
process.env.CLUB_COINS_HARD_DISABLED = 'true';
process.env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE = 'false';

test('historical Stripe and PayPal events are safely replayed after the legacy webhook migrations', async () => {
  const prisma = createTestPrismaClient(databaseUrl);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `marketplace-webhook-upgrade-${identity}-`));
  try {
    const initial = await prisma.$queryRaw`SELECT to_regclass('public."_prisma_migrations"') IS NULL AS empty`;
    assert.equal(initial[0]?.empty, true, 'Upgrade regression requires a fresh disposable database.');
    assert.equal(existsSync(path.join(tempDir, '.env')), false);

    const schemaPath = path.join(tempDir, 'schema.prisma');
    const migrationsPath = path.join(tempDir, 'migrations');
    mkdirSync(migrationsPath, { recursive: true });
    cpSync(path.join(sourcePrismaDir, 'schema.prisma'), schemaPath);
    cpSync(path.join(sourcePrismaDir, 'migrations', 'migration_lock.toml'), path.join(migrationsPath, 'migration_lock.toml'));
    const migrationNames = readdirSync(path.join(sourcePrismaDir, 'migrations'))
      .filter(name => statSync(path.join(sourcePrismaDir, 'migrations', name)).isDirectory())
      .sort();
    const beforeIdentityMigrations = migrationNames.filter(name => name <= '20261023000030_legacy_store_checkout_currency_offer');
    assert.ok(beforeIdentityMigrations.length >= 30);
    for (const name of beforeIdentityMigrations) cpSync(path.join(sourcePrismaDir, 'migrations', name), path.join(migrationsPath, name), { recursive: true });

    function deployFromTemp() {
      const child = spawnSync(process.execPath, [
        prismaCli, 'migrate', 'deploy', '--config', path.join(rootDir, 'apps', 'api', 'prisma.config.ts'), '--schema', schemaPath
      ], {
        cwd: tempDir,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          PRISMA_MIGRATIONS_PATH: migrationsPath,
          DOTENV_CONFIG_PATH: path.join(tempDir, 'not-present.env')
        },
        encoding: 'utf8',
        windowsHide: true
      });
      const safe = `${child.stdout ?? ''}${child.stderr ?? ''}`.replaceAll(databaseUrl, '[redacted disposable database URL]');
      assert.equal(child.error, undefined, `Prisma migration process could not start: ${child.error?.message ?? ''}`);
      assert.equal(child.status, 0, `Prisma migrate deploy failed (${child.status}):\n${safe}`);
      return safe;
    }

    deployFromTemp();
    const eventIds = {
      stripeCapture: `evt_legacy_stripe_capture_${identity}`,
      paypalCapture: `evt_legacy_paypal_capture_${identity}`,
      stripeUnassociated: `evt_legacy_stripe_unassociated_${identity}`,
      stripeAmbiguous: `evt_legacy_stripe_ambiguous_${identity}`,
      paypalAmbiguous: `evt_legacy_paypal_ambiguous_${identity}`
    };
    const walletEventId = `evt_legacy_wallet_${identity}`;
    for (const [key, provider] of [
      ['stripeCapture', 'STRIPE'], ['paypalCapture', 'PAYPAL'], ['stripeUnassociated', 'STRIPE'],
      ['stripeAmbiguous', 'STRIPE'], ['paypalAmbiguous', 'PAYPAL']
    ]) {
      await prisma.$executeRaw`INSERT INTO "ProcessedWebhookEvent" ("id", "provider", "eventId", "receivedAt", "eventType", "reviewReason")
        VALUES (${`legacy-${key}-${identity}`}, ${provider}::"PaymentMethod", ${eventIds[key]}, CURRENT_TIMESTAMP, NULL, NULL)`;
    }
    await prisma.$executeRaw`INSERT INTO "ProcessedWebhookEvent" ("id", "provider", "eventId", "receivedAt", "eventType", "reviewReason")
      VALUES (${`legacy-wallet-webhook-${identity}`}, 'STRIPE', ${walletEventId}, CURRENT_TIMESTAMP, NULL, NULL)`;
    await prisma.$executeRaw`INSERT INTO "AuditLog" ("id", "action", "entity", "entityId", "metadata")
      VALUES (${`legacy-wallet-audit-${identity}`}, 'WALLET_FUNDING_CONFIRMED', 'WalletFundingIntent', 'synthetic-wallet-intent', ${JSON.stringify({ providerEventId: walletEventId })}::jsonb)`;

    for (const name of migrationNames.filter(name => name > '20261023000030_legacy_store_checkout_currency_offer')) {
      cpSync(path.join(sourcePrismaDir, 'migrations', name), path.join(migrationsPath, name), { recursive: true });
    }
    deployFromTemp();

    for (const [key, provider] of [
      ['stripeCapture', 'STRIPE'], ['paypalCapture', 'PAYPAL'], ['stripeUnassociated', 'STRIPE'],
      ['stripeAmbiguous', 'STRIPE'], ['paypalAmbiguous', 'PAYPAL']
    ]) {
      const rows = await prisma.$queryRaw`SELECT "identityVerified", "reviewReason", "eventType", "parentOrderId", "providerObjectRef", "paymentLookupRef"
        FROM "ProcessedWebhookEvent" WHERE "provider" = ${provider}::"PaymentMethod" AND "eventId" = ${eventIds[key]}`;
      assert.equal(rows.length, 1, `${key} must survive the historical upgrade`);
      assert.equal(rows[0].identityVerified, false, `${key} must require verified replay`);
      assert.equal(rows[0].reviewReason, 'LEGACY_EVENT_REQUIRES_RECONCILIATION');
      assert.equal(rows[0].eventType, null);
      assert.equal(rows[0].parentOrderId, null);
      assert.equal(rows[0].providerObjectRef, null);
      assert.equal(rows[0].paymentLookupRef, null);
    }
    const walletRow = await prisma.$queryRaw`SELECT "identityVerified", "reviewReason" FROM "ProcessedWebhookEvent"
      WHERE "provider" = 'STRIPE' AND "eventId" = ${walletEventId}`;
    assert.equal(walletRow.length, 1);
    assert.equal(walletRow[0].identityVerified, true, 'Wallet-funding audit identities must not be backfilled as marketplace legacy events.');
    assert.equal(walletRow[0].reviewReason, null);
    const applied = await prisma.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`;
    assert.equal(applied[0]?.count, migrationNames.length, 'The upgrade must apply the entire migration chain.');

    const [{ reconcileVerifiedPaymentEvent }, safety] = await Promise.all([
      import('../apps/api/src/payment-webhook-reconciliation.ts'),
      import('../apps/api/src/wallet-safety.ts')
    ]);
    assert.equal(safety.isDisposableWalletFundingDatabaseUrl(databaseUrl, identity), true, 'The application wallet database guard must accept only this exact per-run disposable target.');

    const suffix = identity;
    const admin = await prisma.user.create({ data: {
      email: `legacy-upgrade-admin-${suffix}@example.test`, name: 'Synthetic Upgrade Admin', role: 'ADMIN', passwordHash: 'synthetic-only'
    } });
    const sellerUser = await prisma.user.create({ data: {
      email: `legacy-upgrade-seller-${suffix}@example.test`, name: 'Synthetic Upgrade Seller', role: 'SELLER', passwordHash: 'synthetic-only'
    } });
    const seller = await prisma.seller.create({ data: { userId: sellerUser.id, status: 'APPROVED' } });
    const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Legacy Replay Store ${suffix}`, slug: `legacy-replay-${suffix}` } });
    const product = await prisma.product.create({ data: {
      sellerId: seller.id, name: 'Synthetic Historical Replay Product', slug: `legacy-replay-product-${suffix}`,
      description: 'Disposable historical webhook replay fixture', priceMinor: 10_000, currency: 'USD', status: 'APPROVED'
    } });
    const policy = await prisma.sellerCommissionPolicyVersion.create({ data: {
      version: 1, status: 'ACTIVE', storeId: store.id, type: 'PERCENTAGE', currency: 'USD', basisPoints: 1_000,
      reason: 'Synthetic historical replay policy', createdById: admin.id, effectiveFrom: new Date(Date.now() - 60_000)
    } });
    await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { affiliateEnabled: true }, create: { id: 'default', affiliateEnabled: true } });
    const affiliateUser = await prisma.user.create({ data: {
      email: `legacy-upgrade-affiliate-${suffix}@example.test`, name: 'Synthetic Upgrade Affiliate', role: 'BUYER', passwordHash: 'synthetic-only'
    } });
    const affiliate = await prisma.affiliateProfile.create({ data: {
      userId: affiliateUser.id, status: 'APPROVED', referralCode: `legacy-upgrade-affiliate-${suffix}`, termsAcceptedAt: new Date()
    } });
    const affiliateLink = await prisma.affiliateLink.create({ data: {
      affiliateId: affiliate.id, targetPath: '/', code: `legacy-upgrade-link-${suffix}`
    } });

    async function createOrder(label, { provider, providerRef, withAffiliate = false } = {}) {
      let affiliateClickId;
      if (withAffiliate) {
        const click = await prisma.affiliateClick.create({ data: {
          affiliateId: affiliate.id, linkId: affiliateLink.id, tokenHash: `legacy-upgrade-token-${label}-${suffix}`,
          expiresAt: new Date(Date.now() + 60 * 60_000), consentGivenAt: new Date()
        } });
        affiliateClickId = click.id;
      }
      const sessionId = `cs_legacy_${label}_${suffix}`;
      const paymentIntentId = `pi_legacy_${label}_${suffix}`;
      const paypalOrderId = `paypal_legacy_${label}_${suffix}`;
      const commissionSnapshotJson = {
        version: 1, policyVersionId: policy.id, policyVersion: 1, source: 'STORE', type: 'PERCENTAGE',
        fixedMinor: null, basisPoints: 1_000, minimumMinor: null, capMinor: null, currency: 'USD',
        capturedAt: new Date().toISOString(), reason: policy.reason
      };
      const order = await prisma.parentOrder.create({ data: {
        orderNumber: `MV-LEGACY-${label}-${suffix.slice(0, 10)}`,
        buyerEmail: 'synthetic-legacy-buyer@example.test', buyerName: 'Synthetic Legacy Buyer', addressJson: { country: 'US' },
        totalMinor: 10_000, currency: 'USD', affiliateClickId,
        sellerOrders: { create: {
          sellerId: seller.id, totalMinor: 10_000, status: 'PENDING', commissionPolicyVersionId: policy.id,
          commissionSnapshotJson,
          items: { create: { productId: product.id, productName: product.name, unitPriceMinor: 10_000, quantity: 1, currencySnapshot: 'USD' } }
        } },
        payment: { create: { method: provider, status: 'PENDING', providerRef } }
      }, include: { sellerOrders: { include: { items: true } } } });
      return { order, item: order.sellerOrders[0].items[0], sessionId, paymentIntentId, paypalOrderId };
    }

    async function reconcile(event) {
      return prisma.$transaction(tx => reconcileVerifiedPaymentEvent(tx, event), { isolationLevel: 'ReadCommitted' });
    }

    function captureEvent(provider, eventId, fixture, overrides = {}) {
      const paypal = provider === 'PAYPAL';
      return {
        provider,
        eventId,
        eventType: paypal ? 'PAYMENT.CAPTURE.COMPLETED' : 'checkout.session.completed',
        providerObjectRef: paypal ? fixture.paypalOrderId : fixture.paymentIntentId,
        paymentLookupRef: paypal ? fixture.paypalOrderId : fixture.sessionId,
        metadataOrderId: fixture.order.id,
        amountMinor: 10_000,
        currency: 'USD',
        occurredAt: new Date('2026-10-24T00:00:00.000Z'),
        captureConfirmed: true,
        ...overrides
      };
    }

    async function assertCaptured(fixture, event) {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { parentId: fixture.order.id } });
      assert.equal(payment.method, event.provider);
      assert.equal(payment.status, 'PAID');
      assert.equal(payment.providerRef, event.providerObjectRef);
      assert.equal((await prisma.parentOrder.findUniqueOrThrow({ where: { id: fixture.order.id } })).status, 'CONFIRMED');

      const persisted = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } } });
      assert.equal(persisted.identityVerified, true);
      assert.equal(persisted.eventType, event.eventType);
      assert.equal(persisted.providerObjectRef, event.providerObjectRef);
      assert.equal(persisted.paymentLookupRef, event.paymentLookupRef);
      assert.equal(persisted.metadataOrderId, fixture.order.id);
      assert.equal(persisted.parentOrderId, fixture.order.id);
      assert.equal(persisted.amountMinor, 10_000);
      assert.equal(persisted.currency, 'USD');
      assert.equal(persisted.captureConfirmed, true);
      assert.equal(persisted.reviewReason, null);

      const sellerEntries = await prisma.sellerCommissionLedgerEntry.findMany({
        where: { sellerOrder: { parentId: fixture.order.id } }, orderBy: { createdAt: 'asc' }
      });
      assert.equal(sellerEntries.length, 1);
      assert.deepEqual({ entryType: sellerEntries[0].entryType, amountMinor: sellerEntries[0].amountMinor, eligibleBaseMinor: sellerEntries[0].eligibleBaseMinor, currency: sellerEntries[0].currency, sourceEventId: sellerEntries[0].sourceEventId }, {
        entryType: 'ACCRUAL', amountMinor: 1_000, eligibleBaseMinor: 10_000, currency: 'USD', sourceEventId: event.eventId
      });
      const affiliateEntries = await prisma.commissionLedger.findMany({ where: { orderItem: { sellerOrder: { parentId: fixture.order.id } } } });
      assert.equal(affiliateEntries.length, 1);
      assert.deepEqual({ entryType: affiliateEntries[0].entryType, amountMinor: affiliateEntries[0].amountMinor, eligibleBaseMinor: affiliateEntries[0].eligibleBaseMinor, currency: affiliateEntries[0].currency, sourceEventId: affiliateEntries[0].sourceEventId }, {
        entryType: 'EARNED', amountMinor: 500, eligibleBaseMinor: 10_000, currency: 'USD', sourceEventId: event.eventId
      });
      assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: payment.id } }), 1);
      return { payment, persisted };
    }

    const stripeCaptureFixture = await createOrder('stripe-safe', {
      provider: 'STRIPE', providerRef: `cs_legacy_stripe-safe_${suffix}`, withAffiliate: true
    });
    const paypalCaptureFixture = await createOrder('paypal-safe', {
      provider: 'PAYPAL', providerRef: `paypal_legacy_paypal-safe_${suffix}`, withAffiliate: true
    });
    const stripeUnassociatedFixture = await createOrder('stripe-unassociated', {
      provider: 'STRIPE', providerRef: `stale_legacy_${suffix}`, withAffiliate: true
    });

    for (const [provider, fixture, eventId] of [
      ['STRIPE', stripeCaptureFixture, eventIds.stripeCapture],
      ['PAYPAL', paypalCaptureFixture, eventIds.paypalCapture]
    ]) {
      const event = captureEvent(provider, eventId, fixture);
      const result = await reconcile(event);
      assert.deepEqual(result, { orderId: fixture.order.id, becamePaid: true, adjustments: [], reviewReason: null });
      const { payment, persisted } = await assertCaptured(fixture, event);
      assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', entityId: persisted.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: persisted.id } }), 0);

      const duplicate = await reconcile(event);
      assert.deepEqual(duplicate, { orderId: fixture.order.id, becamePaid: false, adjustments: [], reviewReason: null });
      assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: fixture.order.id } } }), 1);
      assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: fixture.order.id } } } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: payment.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', entityId: persisted.id } }), 1);
    }

    const unassociatedEvent = captureEvent('STRIPE', eventIds.stripeUnassociated, stripeUnassociatedFixture);
    const firstUnassociatedResult = await reconcile(unassociatedEvent);
    assert.equal(firstUnassociatedResult.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    let unassociatedRow = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: eventIds.stripeUnassociated } } });
    assert.equal(unassociatedRow.identityVerified, true);
    assert.equal(unassociatedRow.parentOrderId, null);
    assert.equal(unassociatedRow.reviewReason, 'AWAITING_CAPTURE_ASSOCIATION');
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: stripeUnassociatedFixture.order.id } })).status, 'PENDING');
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: stripeUnassociatedFixture.order.id } } }), 0);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: stripeUnassociatedFixture.order.id } } } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: unassociatedRow.id } }), 1);

    await prisma.payment.update({ where: { parentId: stripeUnassociatedFixture.order.id }, data: { providerRef: unassociatedEvent.paymentLookupRef } });
    const associatedRetry = await reconcile(unassociatedEvent);
    assert.deepEqual(associatedRetry, { orderId: stripeUnassociatedFixture.order.id, becamePaid: true, adjustments: [], reviewReason: null });
    const { payment: retriedPayment, persisted: retriedEvent } = await assertCaptured(stripeUnassociatedFixture, unassociatedEvent);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: retriedEvent.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_RECONCILED', entityId: retriedEvent.id } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: retriedPayment.id } }), 1);
    assert.equal((await reconcile(unassociatedEvent)).reviewReason, null);
    assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: stripeUnassociatedFixture.order.id } } }), 1);
    assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: stripeUnassociatedFixture.order.id } } } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYMENT_CAPTURE_RECONCILED', entityId: retriedPayment.id } }), 1);

    const stripeSharedRef = `cs_legacy_ambiguous_${suffix}`;
    const paypalSharedRef = `paypal_legacy_ambiguous_${suffix}`;
    const stripeAmbiguousA = await createOrder('stripe-ambiguous-a', { provider: 'STRIPE', providerRef: stripeSharedRef });
    const stripeAmbiguousB = await createOrder('stripe-ambiguous-b', { provider: 'STRIPE', providerRef: stripeSharedRef });
    const paypalAmbiguousA = await createOrder('paypal-ambiguous-a', { provider: 'PAYPAL', providerRef: paypalSharedRef });
    const paypalAmbiguousB = await createOrder('paypal-ambiguous-b', { provider: 'PAYPAL', providerRef: paypalSharedRef });
    const ambiguousEvents = [
      {
        event: captureEvent('STRIPE', eventIds.stripeAmbiguous, { ...stripeAmbiguousA, sessionId: stripeSharedRef }),
        fixtures: [stripeAmbiguousA, stripeAmbiguousB],
        provider: 'STRIPE',
        initialReason: 'LEGACY_EVENT_REQUIRES_MANUAL_REVIEW'
      },
      {
        event: captureEvent('PAYPAL', eventIds.paypalAmbiguous, { ...paypalAmbiguousA, paypalOrderId: paypalSharedRef }),
        fixtures: [paypalAmbiguousA, paypalAmbiguousB],
        provider: 'PAYPAL',
        initialReason: 'LEGACY_EVENT_REQUIRES_MANUAL_REVIEW'
      }
    ];
    for (const scenario of ambiguousEvents) {
      const firstReview = await reconcile(scenario.event);
      assert.equal(firstReview.orderId, null);
      assert.equal(firstReview.reviewReason, scenario.initialReason);
      let reviewRow = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: scenario.provider, eventId: scenario.event.eventId } } });
      assert.equal(reviewRow.identityVerified, true);
      assert.equal(reviewRow.parentOrderId, null, 'Provider reference ambiguity must not be resolved by metadata alone.');
      assert.equal(reviewRow.reviewReason, scenario.initialReason);
      assert.equal(reviewRow.metadataOrderId, scenario.fixtures[0].order.id);
      assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: reviewRow.id } }), 1);

      const replay = await reconcile(scenario.event);
      assert.equal(replay.orderId, null);
      assert.ok(replay.reviewReason, 'An ambiguous replay must not be acknowledged as complete.');
      reviewRow = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { id: reviewRow.id } });
      assert.ok(reviewRow.reviewReason);
      assert.equal(reviewRow.parentOrderId, null);
      assert.equal(await prisma.auditLog.count({ where: { action: 'LEGACY_PAYMENT_WEBHOOK_REVIEW_REQUIRED', entityId: reviewRow.id } }), 1);
      for (const fixture of scenario.fixtures) {
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { parentId: fixture.order.id } })).status, 'PENDING');
        assert.equal(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: fixture.order.id } } }), 0);
        assert.equal(await prisma.commissionLedger.count({ where: { orderItem: { sellerOrder: { parentId: fixture.order.id } } } }), 0);
      }
    }

    const walletControl = await prisma.processedWebhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'STRIPE', eventId: walletEventId } } });
    assert.equal(walletControl.identityVerified, true);
    assert.equal(walletControl.reviewReason, null);
    assert.equal(walletControl.eventType, null);
    assert.equal(await prisma.auditLog.count({ where: { entity: 'WalletFundingIntent', metadata: { path: ['providerEventId'], equals: walletEventId } } }), 1);
  } finally {
    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
