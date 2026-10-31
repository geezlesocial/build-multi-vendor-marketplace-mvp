import { expect, test, type Page } from '@playwright/test';
import { Prisma, Role, SellerStatus } from '@prisma/client';
import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const demoPassword = 'LocalDemoOnly-ChangeMe-123!';
const adminEmail = 'admin.local@example.test';
const sellerEmail = 'seller.local@example.test';
const isolatedSellerPassword = 'PlanBilling-Isolation-Test-Only-2026!';
const pepper = process.env.PASSWORD_PEPPER;
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!pepper) throw new Error('PASSWORD_PEPPER is required for disposable billing fixtures.');
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; no default database is permitted.');
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

async function signIn(page: Page, email: string, password = demoPassword) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

const webhookSigner = new Stripe('sk_test_e2e_local_only_unused');
const billingWebhookSecret = 'whsec_e2e_local_only_synthetic_signing_key';
async function postSignedBillingEvent(page: Page, event: { id: string; type: string; created: number; data: { object: Record<string, unknown> } }) {
  const payload = JSON.stringify(event);
  const signature = webhookSigner.webhooks.generateTestHeaderString({ payload, secret: billingWebhookSecret });
  return page.request.post('/api/webhooks/stripe/store-billing', { data: payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } });
}

async function createIsolatedSeller() {
  const email = `billing-isolation-${randomUUID().slice(0, 8)}@example.test`;
  const passwordHash = await bcrypt.hash(`${isolatedSellerPassword}${pepper}`, 4);
  const user = await prisma.user.create({
    data: {
      email, name: 'Billing Isolation Seller', role: Role.SELLER, passwordHash, onboardingCompletedAt: new Date(),
      seller: { create: { status: SellerStatus.APPROVED, store: { create: { name: 'Billing Isolation Store', slug: `billing-isolation-${randomUUID().slice(0, 8)}` } } } }
    }, include: { seller: { include: { store: true } } }
  });
  if (!user.seller?.store) throw new Error('Isolated Store fixture creation failed.');
  return { email, userId: user.id, storeId: user.seller.store.id };
}

test.afterAll(async () => { await prisma.$disconnect(); });

test('admin pricing versions are auditable and immutable; seller checkout stays disabled and scoped', async ({ page, browser }) => {
  await signIn(page, adminEmail);
  await page.goto('/admin/platform');
  await page.getByRole('button', { name: 'Store plans' }).click();
  await expect(page.getByRole('heading', { name: 'Store plans and versions' })).toBeVisible();

  const key = `billing-${randomUUID().slice(0, 7)}`;
  await page.getByLabel('Plan name').fill('Market Lane Plus');
  await page.getByLabel('Plan key').fill(key);
  await page.getByLabel('Plan description').fill('Expanded tools for growing independent stores.');
  await page.getByLabel('Monthly price').fill('20.00');
  await page.getByLabel('Annual pricing').selectOption('DISCOUNT');
  await page.getByLabel('Annual discount (%)').fill('10');
  await page.getByLabel('Default billing interval').selectOption('ANNUAL');
  await page.getByLabel('Free-trial days').fill('14');
  await page.getByLabel('Paid introductory price').fill('1.00');
  await page.getByLabel('Paid introductory days').fill('30');
  await expect(page.locator('.storePlanPricePreview')).toContainText('USD 216.00 per year');
  await expect(page.locator('.storePlanPricePreview')).toContainText('saves USD 24.00');
  await expect(page.locator('.storePlanPricePreview')).toContainText('14-day free trial');
  await expect(page.locator('.storePlanPricePreview')).toContainText('Paid introductory charge: USD 1.00');
  await page.getByLabel('Reason for change').fill('Create priced version for isolated browser verification');
  const createWait = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/store-plans' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create draft plan' }).click();
  const createdResponse = await createWait;
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);

  const listResponse = await page.request.get('/api/admin/store-plans');
  const plans = await listResponse.json() as { id: string; key: string; versions: { id: string; version: number; status: string; monthlyPriceMinor: number; annualPriceMinor: number; annualDiscountPercent: number | null; freeTrialDays: number; introPriceMinor: number | null; introDurationDays: number | null }[] }[];
  const plan = plans.find(item => item.key === key)!;
  const draft = plan.versions.find(version => version.version === 1)!;
  expect(draft).toMatchObject({ monthlyPriceMinor: 2000, annualPriceMinor: 21600, annualDiscountPercent: 10, freeTrialDays: 14, introPriceMinor: 100, introDurationDays: 30, status: 'DRAFT' });

  page.on('dialog', dialog => dialog.accept());
  const planCard = page.locator('.storePlanAdminCard').filter({ hasText: key });
  const activationResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/admin/store-plans/${plan.id}/activate` && response.request().method() === 'POST'
  );
  await planCard.getByRole('button', { name: 'Activate version' }).click();
  const activationResponse = await activationResponsePromise;
  const activationResponseText = await activationResponse.text();
  expect(activationResponse.status(), activationResponseText).toBe(200);
  const activationResult = JSON.parse(activationResponseText) as {
    plan: { id: string; status: string };
    version: { id: string; status: string };
    alreadyActive: boolean;
  };
  expect(activationResult).toMatchObject({
    plan: { id: plan.id, status: 'ACTIVE' },
    version: { id: draft.id, status: 'ACTIVE' },
    alreadyActive: false
  });
  await expect(planCard.getByText(/Version 1.*ACTIVE.*0 assignment\(s\)/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Store plans' }).click();
  const reloadedPlanCard = page.locator('.storePlanAdminCard').filter({ hasText: key });
  await expect(reloadedPlanCard.getByText(/Version 1.*ACTIVE.*0 assignment\(s\)/)).toBeVisible();
  const activated = await prisma.storePlanVersion.findUniqueOrThrow({ where: { id: draft.id } });
  expect(activated.status).toBe('ACTIVE');
  const persistedPlansResponse = await page.request.get('/api/admin/store-plans');
  expect(persistedPlansResponse.ok()).toBeTruthy();
  const persistedPlans = await persistedPlansResponse.json() as { key: string; versions: { id: string; status: string }[] }[];
  expect(persistedPlans.find(item => item.key === key)?.versions.find(version => version.id === draft.id)?.status).toBe('ACTIVE');
  await expect(prisma.storePlanVersion.update({ where: { id: draft.id }, data: { monthlyPriceMinor: 1 } })).rejects.toThrow();

  const revised = await page.request.patch(`/api/admin/store-plans/${plan.id}`, {
    headers: await csrfHeaders(page),
    data: { pricing: { description: 'Revised draft only', currency: 'USD', monthlyPrice: '25.00', annualPriceMode: 'FULL', defaultInterval: 'MONTHLY', termIntervals: null, expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_ANYTIME', freeTrialDays: 0 }, reason: 'Create a new draft without changing subscribed terms' }
  });
  expect(revised.status(), await revised.text()).toBe(200);
  const afterEdit = await prisma.storePlanVersion.findMany({ where: { planId: plan.id }, orderBy: { version: 'asc' } });
  expect(afterEdit.map(version => [version.version, version.status, version.monthlyPriceMinor])).toEqual([[1, 'ACTIVE', 2000], [2, 'DRAFT', 2500]]);

  const storesResponse = await page.request.get('/api/admin/store-plan-stores');
  const stores = await storesResponse.json() as { id: string; seller: { user: { email: string } } }[];
  const ownStore = stores.find(store => store.seller.user.email === sellerEmail)!;
  const paidAssignment = await page.request.post(`/api/admin/store-plan-stores/${ownStore.id}/assignments`, { headers: await csrfHeaders(page), data: { versionId: draft.id, reason: 'Must not bypass subscription payment' } });
  expect(paidAssignment.status()).toBe(409);
  expect(await paidAssignment.json()).toMatchObject({ error: expect.stringContaining('Paid plan entitlements') });

  const sellerContext = await browser.newContext();
  try {
    const sellerPage = await sellerContext.newPage();
    await signIn(sellerPage, sellerEmail);
    expect((await sellerPage.request.get('/api/admin/store-plans')).status()).toBe(403);
    await sellerPage.goto('/seller/plan');
    await expect(sellerPage.getByRole('heading', { name: 'Plan & Billing' })).toBeVisible();
    await expect(sellerPage.getByText(/Subscription checkout is unavailable/)).toBeVisible();
    const optionsResponse = await sellerPage.request.get('/api/seller/plan-options');
    expect(optionsResponse.status()).toBe(200);
    const options = await optionsResponse.json() as {
      checkoutAvailable: boolean;
      checkoutUnavailableReason: string;
      offers: { id: string; plan: { key: string }; version: number }[];
    };
    expect(options.checkoutAvailable).toBe(false);
    expect(options.offers.length).toBeGreaterThan(0);
    const upgradeButtons = sellerPage.getByRole('button', { name: 'Upgrade unavailable' });
    await expect(upgradeButtons).toHaveCount(options.offers.length);
    for (const offer of options.offers) {
      const offerCard = sellerPage.locator('.planOfferGrid article').filter({
        hasText: `${offer.plan.key} · version ${offer.version}`
      });
      await expect(offerCard).toHaveCount(1);
      const upgradeButton = offerCard.getByRole('button', { name: 'Upgrade unavailable' });
      await expect(upgradeButton).toBeVisible();
      await expect(upgradeButton).toBeDisabled();
      await expect(upgradeButton).toHaveAttribute('title', options.checkoutUnavailableReason);
    }
    const before = await prisma.storeSubscription.count({ where: { storeId: ownStore.id } });
    const subscribe = await sellerPage.request.post('/api/seller/billing/subscribe', { headers: await csrfHeaders(sellerPage), data: { planVersionId: draft.id, interval: 'ANNUAL' } });
    expect(subscribe.status()).toBe(503);
    expect(await subscribe.json()).toMatchObject({ code: 'PLAN_BILLING_DISABLED' });
    expect(await prisma.storeSubscription.count({ where: { storeId: ownStore.id } })).toBe(before);
    const planRead = await sellerPage.request.get('/api/seller/plan');
    expect((await planRead.json()).plan.key).toBe('legacy-compatible');
  } finally { await sellerContext.close(); }
});

test('pending billing history, invoice idempotency, and provider-event dedupe remain Store-scoped', async ({ browser }) => {
  const admin = await browser.newPage();
  await signIn(admin, adminEmail);
  const planList = await admin.request.get('/api/admin/store-plans');
  const plans = await planList.json() as { id: string; key: string; versions: { id: string; status: string }[] }[];
  let versionId = plans.flatMap(plan => plan.versions.map(version => ({ planId: plan.id, key: plan.key, ...version }))).find(row => row.key.startsWith('billing-') && row.status === 'ACTIVE')?.id;
  if (!versionId) {
    const legacy = plans.find(plan => plan.key === 'legacy-compatible')!;
    versionId = legacy.versions.find(version => version.status === 'ACTIVE')!.id;
  }
  const isolated = await createIsolatedSeller();
  const subscription = await prisma.storeSubscription.create({ data: {
    storeId: isolated.storeId, planVersionId: versionId, requestedById: isolated.userId,
    status: 'PENDING', interval: 'MONTHLY', currency: 'USD', monthlyPriceMinor: 1200, annualPriceMinor: 14400,
    introPriceMinor: null, introDurationDays: null, freeTrialDays: 0, termIntervals: null,
    expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_ANYTIME',
    termsSnapshot: { version: 1, currency: 'USD', monthlyPriceMinor: 1200, freeTrialDays: 0 } satisfies Prisma.InputJsonObject
  } });
  const invoice = await prisma.storeSubscriptionInvoice.create({ data: { subscriptionId: subscription.id, idempotencyKey: `invoice-${randomUUID()}`, amountMinor: 1200, currency: 'USD' } });
  const eventId = `synthetic-${randomUUID()}`;
  await prisma.storeSubscriptionEvent.create({ data: { provider: 'STRIPE', providerEventId: eventId, eventType: 'synthetic.test', status: 'RECEIVED', signatureVerified: false, subscriptionId: subscription.id, safeSummary: { fixture: true } } });
  await expect(prisma.storeSubscriptionEvent.create({ data: { provider: 'STRIPE', providerEventId: eventId, eventType: 'synthetic.test' } })).rejects.toThrow();
  await expect(prisma.storeSubscriptionInvoice.create({ data: { subscriptionId: subscription.id, idempotencyKey: invoice.idempotencyKey, amountMinor: 1200, currency: 'USD' } })).rejects.toThrow();

  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    const unrelatedPage = await otherContext.newPage();
    await signIn(ownerPage, isolated.email, isolatedSellerPassword);
    await signIn(unrelatedPage, sellerEmail);
    const ownerHistory = await ownerPage.request.get('/api/seller/billing');
    expect(ownerHistory.ok()).toBeTruthy();
    const ownerBody = await ownerHistory.json();
    expect(ownerBody.subscriptions).toHaveLength(1);
    expect(ownerBody.subscriptions[0]).toMatchObject({ id: subscription.id, status: 'PENDING' });
    expect(ownerBody.subscriptions[0].invoices).toMatchObject([{ id: invoice.id, amountMinor: 1200, status: 'OPEN' }]);
    const unrelatedHistory = await unrelatedPage.request.get(`/api/seller/billing?storeId=${encodeURIComponent(isolated.storeId)}`);
    expect(unrelatedHistory.ok()).toBeTruthy();
    expect((await unrelatedHistory.json()).subscriptions).toEqual([]);
  } finally {
    await ownerContext.close();
    await otherContext.close();
    await admin.close();
  }
});

test('signed Stripe sandbox events grant entitlements only after a paid invoice and reconcile refunds idempotently', async ({ page }) => {
  await signIn(page, adminEmail);
  const plansResponse = await page.request.get('/api/admin/store-plans');
  const plans = await plansResponse.json() as { id: string; key: string; versions: { id: string; version: number; status: string; monthlyPriceMinor: number; annualPriceMinor: number }[] }[];
  const paidVersion = plans.flatMap(plan => plan.versions.map(version => ({ plan, ...version }))).find(row => row.plan.key.startsWith('billing-') && row.status === 'ACTIVE' && row.monthlyPriceMinor > 0);
  expect(paidVersion, 'the preceding billing test creates an active paid plan fixture').toBeTruthy();
  const isolated = await createIsolatedSeller();
  const stripeSubscriptionId = `sub_${randomUUID().replaceAll('-', '')}`;
  const localSubscription = await prisma.storeSubscription.create({ data: {
    storeId: isolated.storeId, planVersionId: paidVersion!.id, requestedById: isolated.userId,
    provider: 'STRIPE', providerSubscriptionId: stripeSubscriptionId, status: 'PENDING', interval: 'MONTHLY', currency: 'USD',
    monthlyPriceMinor: paidVersion!.monthlyPriceMinor, annualPriceMinor: paidVersion!.annualPriceMinor,
    introPriceMinor: null, introDurationDays: null, freeTrialDays: 0, termIntervals: null,
    expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_AT_TERM_END',
    termsSnapshot: { schemaVersion: 1, provider: 'STRIPE', sandbox: true, agreedPriceMinor: paidVersion!.monthlyPriceMinor } satisfies Prisma.InputJsonObject
  } });
  const eventCreated = Math.floor(Date.now() / 1000);
  const ignoredActiveEvent = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.updated', created: eventCreated,
    data: { object: { id: stripeSubscriptionId, object: 'subscription', status: 'active', created: eventCreated, current_period_start: eventCreated, current_period_end: eventCreated + 30 * 86400, cancel_at_period_end: false, metadata: { storeSubscriptionId: localSubscription.id, storeId: isolated.storeId } } }
  });
  expect(ignoredActiveEvent.status(), await ignoredActiveEvent.text()).toBe(200);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).status).toBe('PENDING');
  expect(await prisma.storePlanAssignment.count({ where: { storeId: isolated.storeId, planVersionId: paidVersion!.id, status: 'ACTIVE' } })).toBe(0);

  const invoiceId = `in_${randomUUID().replaceAll('-', '')}`;
  const paidInvoiceEvent = {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.paid', created: eventCreated,
    data: { object: { id: invoiceId, object: 'invoice', currency: 'usd', amount_paid: paidVersion!.monthlyPriceMinor, amount_due: paidVersion!.monthlyPriceMinor, subscription: stripeSubscriptionId, period_start: eventCreated - 30 * 86400, period_end: eventCreated } }
  };
  const paidResponse = await postSignedBillingEvent(page, paidInvoiceEvent);
  expect(paidResponse.status(), await paidResponse.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).toMatchObject({ status: 'ACTIVE', expiresAt: null });
  expect(await prisma.storePlanAssignment.count({ where: { storeId: isolated.storeId, planVersionId: paidVersion!.id, status: 'ACTIVE', source: 'SUBSCRIPTION' } })).toBe(1);
  expect(await prisma.storeSubscriptionInvoice.count({ where: { subscriptionId: localSubscription.id, providerInvoiceId: invoiceId, status: 'PAID' } })).toBe(1);
  const paidAuditCount = await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: localSubscription.id, action: 'STORE_SUBSCRIPTION_INVOICE_PAID' } });
  expect(paidAuditCount).toBe(1);
  const duplicatePaidResponse = await postSignedBillingEvent(page, paidInvoiceEvent);
  expect(duplicatePaidResponse.status(), await duplicatePaidResponse.text()).toBe(200);
  expect(await duplicatePaidResponse.json()).toMatchObject({ duplicate: true, reconciliation: 'APPLIED' });
  expect(await prisma.storeSubscriptionInvoice.count({ where: { subscriptionId: localSubscription.id } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: localSubscription.id, action: 'STORE_SUBSCRIPTION_INVOICE_PAID' } })).toBe(paidAuditCount);
  const staleFailureResponse = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.payment_failed', created: eventCreated + 1,
    data: { object: { id: invoiceId, object: 'invoice', currency: 'usd', amount_due: paidVersion!.monthlyPriceMinor, subscription: stripeSubscriptionId, period_start: eventCreated, period_end: eventCreated + 30 * 86400 } }
  });
  expect(staleFailureResponse.status(), await staleFailureResponse.text()).toBe(200);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).status).toBe('ACTIVE');
  expect((await prisma.storeSubscriptionInvoice.findUniqueOrThrow({ where: { idempotencyKey: `stripe-invoice-${invoiceId}` } })).status).toBe('PAID');

  const badFailureInvoiceId = `in_${randomUUID().replaceAll('-', '')}`;
  const badFailureEvent = {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.payment_failed', created: eventCreated,
    data: { object: { id: badFailureInvoiceId, object: 'invoice', currency: 'usd', amount_due: paidVersion!.monthlyPriceMinor + 1, subscription: stripeSubscriptionId, period_start: eventCreated, period_end: eventCreated + 30 * 86400 } }
  };
  const rejectedFailure = await postSignedBillingEvent(page, badFailureEvent);
  expect(rejectedFailure.status(), await rejectedFailure.text()).toBe(500);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).status).toBe('ACTIVE');
  expect(await prisma.storeSubscriptionInvoice.findFirst({ where: { providerInvoiceId: badFailureInvoiceId } })).toBeNull();
  expect(await prisma.storeSubscriptionEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: badFailureEvent.id } } })).toMatchObject({ status: 'FAILED', errorCode: 'INVOICE_AMOUNT_MISMATCH' });

  const failureEvent = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.payment_failed', created: eventCreated,
    data: { object: { id: `in_${randomUUID().replaceAll('-', '')}`, object: 'invoice', currency: 'usd', amount_due: paidVersion!.monthlyPriceMinor, subscription: stripeSubscriptionId, period_start: eventCreated, period_end: eventCreated + 30 * 86400 } }
  });
  expect(failureEvent.status(), await failureEvent.text()).toBe(200);
  const pastDue = await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } });
  expect(pastDue.status).toBe('PAST_DUE');
  expect(pastDue.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  expect(await prisma.storePlanAssignment.count({ where: { storeId: isolated.storeId, planVersionId: paidVersion!.id, status: 'ACTIVE' } })).toBe(1);
  const initialGraceEnd = pastDue.expiresAt!.getTime();
  const repeatedFailure = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.payment_failed', created: eventCreated + 60,
    data: { object: { id: `in_${randomUUID().replaceAll('-', '')}`, object: 'invoice', currency: 'usd', amount_due: paidVersion!.monthlyPriceMinor, subscription: stripeSubscriptionId, period_start: eventCreated, period_end: eventCreated + 30 * 86400 } }
  });
  expect(repeatedFailure.status(), await repeatedFailure.text()).toBe(200);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).expiresAt!.getTime()).toBe(initialGraceEnd);
  const repeatedPastDueState = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.updated', created: eventCreated + 120,
    data: { object: { id: stripeSubscriptionId, object: 'subscription', status: 'past_due', created: eventCreated - 1, current_period_start: eventCreated, current_period_end: eventCreated + 30 * 86400, cancel_at_period_end: false, metadata: { storeSubscriptionId: localSubscription.id, storeId: isolated.storeId } } }
  });
  expect(repeatedPastDueState.status(), await repeatedPastDueState.text()).toBe(200);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).expiresAt!.getTime()).toBe(initialGraceEnd);

  const refundEvent = {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'charge.refunded', created: eventCreated,
    data: { object: { id: `ch_${randomUUID().replaceAll('-', '')}`, object: 'charge', currency: 'usd', amount_refunded: Math.floor(paidVersion!.monthlyPriceMinor / 2), invoice: invoiceId } }
  };
  const refundResponse = await postSignedBillingEvent(page, refundEvent);
  expect(refundResponse.status(), await refundResponse.text()).toBe(200);
  const refundedInvoice = await prisma.storeSubscriptionInvoice.findUniqueOrThrow({ where: { idempotencyKey: `stripe-invoice-${invoiceId}` } });
  expect(refundedInvoice).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: Math.floor(paidVersion!.monthlyPriceMinor / 2) });
  const refundAuditCount = await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: localSubscription.id, action: 'STORE_SUBSCRIPTION_REFUND_RECORDED' } });
  expect(refundAuditCount).toBe(1);
  const duplicateRefundResponse = await postSignedBillingEvent(page, refundEvent);
  expect(duplicateRefundResponse.status(), await duplicateRefundResponse.text()).toBe(200);
  expect(await prisma.storeSubscriptionInvoice.findUniqueOrThrow({ where: { id: refundedInvoice.id } })).toMatchObject({ refundedMinor: refundedInvoice.refundedMinor, status: 'PARTIALLY_REFUNDED' });
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: localSubscription.id, action: 'STORE_SUBSCRIPTION_REFUND_RECORDED' } })).toBe(refundAuditCount);
  const staleRefund = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'charge.refunded', created: eventCreated + 120,
    data: { object: { id: refundEvent.data.object.id, object: 'charge', currency: 'usd', amount_refunded: Math.max(0, Math.floor(paidVersion!.monthlyPriceMinor / 2) - 1), invoice: invoiceId } }
  });
  expect(staleRefund.status(), await staleRefund.text()).toBe(200);
  expect(await prisma.storeSubscriptionInvoice.findUniqueOrThrow({ where: { id: refundedInvoice.id } })).toMatchObject({ refundedMinor: refundedInvoice.refundedMinor, status: 'PARTIALLY_REFUNDED' });
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: localSubscription.id, action: 'STORE_SUBSCRIPTION_REFUND_RECORDED' } })).toBe(refundAuditCount);
  const stalePaidEvent = await postSignedBillingEvent(page, { ...paidInvoiceEvent, id: `evt_${randomUUID().replaceAll('-', '')}`, created: eventCreated + 120 });
  expect(stalePaidEvent.status(), await stalePaidEvent.text()).toBe(200);
  expect((await prisma.storeSubscription.findUniqueOrThrow({ where: { id: localSubscription.id } })).status).toBe('PAST_DUE');
  expect(await prisma.storeSubscriptionInvoice.findUniqueOrThrow({ where: { id: refundedInvoice.id } })).toMatchObject({ refundedMinor: refundedInvoice.refundedMinor, status: 'PARTIALLY_REFUNDED' });

  const trialStore = await createIsolatedSeller();
  const trialSubscriptionId = `sub_${randomUUID().replaceAll('-', '')}`;
  const trialEndsAt = eventCreated + 14 * 86_400;
  const trialSubscription = await prisma.storeSubscription.create({ data: {
    storeId: trialStore.storeId, planVersionId: paidVersion!.id, requestedById: trialStore.userId,
    provider: 'STRIPE', providerSubscriptionId: trialSubscriptionId, status: 'PENDING', interval: 'MONTHLY', currency: 'USD',
    monthlyPriceMinor: paidVersion!.monthlyPriceMinor, annualPriceMinor: paidVersion!.annualPriceMinor,
    introPriceMinor: null, introDurationDays: null, freeTrialDays: 14, termIntervals: null,
    expirationBehavior: 'DOWNGRADE_TO_LEGACY', cancellationPolicy: 'CANCEL_AT_TERM_END',
    termsSnapshot: { schemaVersion: 1, provider: 'STRIPE', sandbox: true, agreedPriceMinor: paidVersion!.monthlyPriceMinor, freeTrialDays: 14 } satisfies Prisma.InputJsonObject
  } });
  const trialEvent = {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.created', created: eventCreated,
    data: { object: { id: trialSubscriptionId, object: 'subscription', status: 'trialing', created: eventCreated, current_period_start: eventCreated, current_period_end: trialEndsAt, trial_end: trialEndsAt, cancel_at_period_end: false, metadata: { storeSubscriptionId: trialSubscription.id, storeId: trialStore.storeId } } }
  };
  const trialResponse = await postSignedBillingEvent(page, trialEvent);
  expect(trialResponse.status(), await trialResponse.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).toMatchObject({ status: 'TRIALING', trialEndsAt: new Date(trialEndsAt * 1000) });
  expect(await prisma.storePlanAssignment.count({ where: { storeId: trialStore.storeId, planVersionId: paidVersion!.id, source: 'SUBSCRIPTION', status: 'ACTIVE' } })).toBe(1);
  const trialAuditCount = await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: trialSubscription.id, action: 'STORE_SUBSCRIPTION_TRIAL_STARTED' } });
  expect(trialAuditCount).toBe(1);
  const duplicateTrialState = await postSignedBillingEvent(page, { ...trialEvent, id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.updated' });
  expect(duplicateTrialState.status(), await duplicateTrialState.text()).toBe(200);
  expect(await prisma.storePlanAssignment.count({ where: { storeId: trialStore.storeId, planVersionId: paidVersion!.id, source: 'SUBSCRIPTION', status: 'ACTIVE' } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: trialSubscription.id, action: 'STORE_SUBSCRIPTION_TRIAL_STARTED' } })).toBe(trialAuditCount);
  const scheduledCancellation = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.updated', created: eventCreated + 1,
    data: { object: { id: trialSubscriptionId, object: 'subscription', status: 'trialing', created: eventCreated, current_period_start: eventCreated, current_period_end: trialEndsAt, trial_end: trialEndsAt, cancel_at_period_end: true, metadata: { storeSubscriptionId: trialSubscription.id, storeId: trialStore.storeId } } }
  });
  expect(scheduledCancellation.status(), await scheduledCancellation.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).toMatchObject({ status: 'TRIALING', cancelAtPeriodEnd: true, expiresAt: new Date(trialEndsAt * 1000) });
  const deletedAtTermEnd = await postSignedBillingEvent(page, {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.deleted', created: eventCreated + 2,
    data: { object: { id: trialSubscriptionId, object: 'subscription', status: 'canceled', created: eventCreated, current_period_start: eventCreated, current_period_end: trialEndsAt, trial_end: trialEndsAt, cancel_at_period_end: true, metadata: { storeSubscriptionId: trialSubscription.id, storeId: trialStore.storeId } } }
  });
  expect(deletedAtTermEnd.status(), await deletedAtTermEnd.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).toMatchObject({ status: 'CANCELLED', cancelAtPeriodEnd: true, expiresAt: new Date(trialEndsAt * 1000) });
  expect(await prisma.storePlanAssignment.count({ where: { storeId: trialStore.storeId, planVersionId: paidVersion!.id, source: 'SUBSCRIPTION', status: 'ACTIVE' } })).toBe(1);

  // Late valid provider snapshots must not resurrect a subscription after a
  // cancellation transition. Record a paid invoice for reconciliation while
  // retaining the terminal subscription and access-expiry state.
  const cancelledExpiry = (await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).expiresAt;
  const latePaidInvoiceId = `in_${randomUUID().replaceAll('-', '')}`;
  const latePaidEvent = {
    id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.paid', created: eventCreated + 3,
    data: { object: { id: latePaidInvoiceId, object: 'invoice', currency: 'usd', amount_paid: paidVersion!.monthlyPriceMinor, amount_due: paidVersion!.monthlyPriceMinor, subscription: trialSubscriptionId, period_start: trialEndsAt, period_end: trialEndsAt + 30 * 86400 } }
  };
  const latePaidResponse = await postSignedBillingEvent(page, latePaidEvent);
  expect(latePaidResponse.status(), await latePaidResponse.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).toMatchObject({ status: 'CANCELLED', expiresAt: cancelledExpiry });
  expect(await prisma.storeSubscriptionInvoice.findFirst({ where: { subscriptionId: trialSubscription.id, providerInvoiceId: latePaidInvoiceId } })).toMatchObject({ status: 'PAID', amountMinor: paidVersion!.monthlyPriceMinor });
  expect(await prisma.storePlanAssignment.count({ where: { storeId: trialStore.storeId, planVersionId: paidVersion!.id, source: 'SUBSCRIPTION', status: 'ACTIVE' } })).toBe(1);
  const terminalInvoiceAuditCount = await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: trialSubscription.id, action: 'STORE_SUBSCRIPTION_INVOICE_PAID' } });
  expect(terminalInvoiceAuditCount).toBe(1);
  const duplicateLatePaid = await postSignedBillingEvent(page, latePaidEvent);
  expect(await duplicateLatePaid.json()).toMatchObject({ duplicate: true, reconciliation: 'APPLIED' });
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: trialSubscription.id, action: 'STORE_SUBSCRIPTION_INVOICE_PAID' } })).toBe(terminalInvoiceAuditCount);

  const lateTrialEvent = { ...trialEvent, id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'customer.subscription.updated', created: eventCreated + 4 };
  const lateTrialResponse = await postSignedBillingEvent(page, lateTrialEvent);
  expect(lateTrialResponse.status(), await lateTrialResponse.text()).toBe(200);
  expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { id: trialSubscription.id } })).toMatchObject({ status: 'CANCELLED', expiresAt: cancelledExpiry });
  expect(await prisma.storePlanAssignment.count({ where: { storeId: trialStore.storeId, planVersionId: paidVersion!.id, source: 'SUBSCRIPTION', status: 'ACTIVE' } })).toBe(1);
  expect(await prisma.auditLog.count({ where: { entity: 'StoreSubscription', entityId: trialSubscription.id, action: 'STORE_SUBSCRIPTION_TRIAL_STARTED' } })).toBe(1);

  const invalidEventId = `evt_invalid_${randomUUID().replaceAll('-', '')}`;
  const beforeInvalid = await prisma.storeSubscriptionEvent.count({ where: { providerEventId: invalidEventId } });
  const invalidResponse = await page.request.post('/api/webhooks/stripe/store-billing', { data: JSON.stringify({ id: invalidEventId, type: 'invoice.paid', created: eventCreated, data: { object: { id: 'in_invalid' } } }), headers: { 'content-type': 'application/json', 'stripe-signature': 'invalid' } });
  expect(invalidResponse.status()).toBe(400);
  expect(await prisma.storeSubscriptionEvent.count({ where: { providerEventId: invalidEventId } })).toBe(beforeInvalid);
});
