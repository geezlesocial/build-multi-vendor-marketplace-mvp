import { expect, test, type Page } from '@playwright/test';
import { PaymentMethod, PaymentStatus, PrismaClient } from '@prisma/client';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const password = 'LocalDemoOnly-ChangeMe-123!';
const adminEmail = 'admin.local@example.test';
const sellerEmail = 'seller.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const e2eBaseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5173}`;
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
if (!e2eDatabaseUrl) throw new Error('E2E_DATABASE_URL is required; payout tests must use the guarded disposable database.');
validateE2EDatabaseURL(e2eDatabaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl } } });

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function csrfHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

test.afterAll(async () => prisma.$disconnect());

test('admin can waive email verification with an audit reason and invalidate the pending token', async ({ page }) => {
  await login(page, adminEmail);
  const target = await prisma.user.create({ data: {
    email: `verification-waiver-${Date.now()}@example.test`,
    name: 'Verification waiver E2E',
    passwordHash: 'not-used-by-this-test',
    emailVerificationTokenHash: `pending-token-${Date.now()}`,
    emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    emailVerificationSentAt: new Date()
  } });
  try {
    const response = await page.request.post(`/api/admin/members/${encodeURIComponent(target.id)}/verify-email`, {
      data: { reason: 'Approved manual identity review' },
      headers: await csrfHeaders(page)
    });
    const responseBody = await response.text();
    expect(response.status(), responseBody).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({ verified: true, alreadyVerified: false });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.emailVerifiedAt).toBeInstanceOf(Date);
    expect(updated.emailVerificationTokenHash).toBeNull();
    expect(updated.emailVerificationExpiresAt).toBeNull();
    expect(updated.emailVerificationSentAt).toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { action: 'ADMIN_EMAIL_VERIFICATION_WAIVED', entityId: target.id } })).not.toBeNull();

    const repeated = await page.request.post(`/api/admin/members/${encodeURIComponent(target.id)}/verify-email`, {
      data: { reason: 'Repeat verification review' },
      headers: await csrfHeaders(page)
    });
    const repeatedBody = await repeated.text();
    expect(repeated.status(), repeatedBody).toBe(200);
    expect(JSON.parse(repeatedBody)).toMatchObject({ verified: true, alreadyVerified: true });
  } finally {
    await prisma.user.delete({ where: { id: target.id } });
  }
});

test('admin can save/publish branding and manage taxonomy while public users cannot', async ({ page }) => {
  await login(page, adminEmail);
  await page.goto('/admin/platform');
  await expect(page.getByRole('heading', { name: 'Control center', exact: true })).toBeVisible();
  const slug = 'home-essentials';
  const draft = await page.request.put('/api/admin/platform/branding', { data: { platformName: 'E2E Market', shortName: 'E2E', description: 'Verified platform identity', seoDescription: 'E2E metadata', tagline: 'Test safely', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null, socialImageMediaId: null, supportEmail: null, supportUrl: null }, headers: await csrfHeaders(page) });
  expect(draft.status()).toBe(200);
  const published = await page.request.post('/api/admin/platform/branding/publish', { data: {}, headers: await csrfHeaders(page) });
  expect(published.status()).toBe(200);
  await expect((await page.request.get('/api/platform/branding')).json()).resolves.toMatchObject({ platformName: 'E2E Market' });
  const category = await page.request.post('/api/admin/categories', { data: { name: 'Home Essentials', slug }, headers: await csrfHeaders(page) });
  expect(category.status()).toBe(201);
  const buyer = await page.context().browser()?.newContext();
  if (!buyer) throw new Error('Browser context unavailable');
  const buyerPage = await buyer.newPage();
  await login(buyerPage, buyerEmail);
  const denied = await buyerPage.request.patch('/api/admin/platform/settings', { data: { sellerPayoutsEnabled: true }, headers: await csrfHeaders(buyerPage) });
  expect(denied.status()).toBe(403);
  await buyer.close();
});

test('approved seller can save a safe theme and seller cannot access admin payout controls', async ({ page }) => {
  await login(page, sellerEmail);
  await page.goto('/seller/platform');
  await expect(page.getByRole('heading', { name: 'Store appearance and payout setup' })).toBeVisible();
  const before = await page.request.get('/api/seller/store-theme');
  expect(before.ok(), await before.text()).toBeTruthy();
  const oldSlug = (await before.json() as { slug: string }).slug;
  const storeName = `Northstar Market ${Date.now()}`;
  const saved = await page.request.put('/api/seller/store-theme', { data: { name: storeName, description: 'Safe seller storefront', primaryColor: '#123456', accentColor: '#abcdef', font: 'system', sections: [], contactLinks: [] }, headers: await csrfHeaders(page) });
  expect(saved.status()).toBe(200);
  const savedBody = await saved.json() as { slug: string; name: string };
  expect(savedBody.name).toBe(storeName);
  expect(savedBody.slug).toBe(storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const published = await page.request.post('/api/seller/store-theme/publish', { data: {}, headers: await csrfHeaders(page) });
  expect(published.status()).toBe(200);
  const oldStore = await page.request.get(`/api/stores/${oldSlug}`);
  expect(oldStore.ok(), await oldStore.text()).toBeTruthy();
  expect(await oldStore.json()).toMatchObject({ redirectTo: `/store/${savedBody.slug}`, statusCode: 301 });
  await page.goto(`/store/${savedBody.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: storeName })).toBeVisible();
  await expect(page.getByText('Safe seller storefront')).toBeVisible();
  await expect(page.locator('article.productCard').getByRole('link', { name: 'Demo Canvas Tote', exact: true })).toBeVisible();
  await expect(page).toHaveTitle(`${storeName} | Market Lane`);
  const adminReadiness = await page.request.get('/api/admin/payout-readiness');
  expect(adminReadiness.status()).toBe(403);
  const disabledMethod = await page.request.post('/api/seller/payout-methods', { data: { type: 'MANUAL_BANK', country: 'US', currency: 'USD', label: 'Test bank', identifier: 'test-account', details: { accountHolder: 'Local test' } }, headers: await csrfHeaders(page) });
  expect(disabledMethod.status()).toBe(409);
});

test('buyer cannot access seller store settings', async ({ page, browser }) => {
  const buyerContext = await browser.newContext({ baseURL: e2eBaseURL });
  const buyerPage = await buyerContext.newPage();
  await login(buyerPage, buyerEmail);
  const denied = await buyerPage.request.get('/api/seller/store-theme');
  expect(denied.status()).toBe(403);
  await buyerContext.close();
});

test('manual seller payout flow stays separate from checkout and requires admin evidence', async ({ page, browser }) => {
  await login(page, adminEmail);
  const settings = await page.request.patch('/api/admin/platform/settings', { data: { sellerPayoutsEnabled: true, payoutFundingConfigured: true, manualBankPayoutsEnabled: true, payoutHoldDays: 0, payoutMinimumMinor: 0, reason: 'Disposable closeout verification' }, headers: await csrfHeaders(page) });
  expect(settings.ok(), await settings.text()).toBeTruthy();

  const sellerContext = await browser.newContext({ baseURL: e2eBaseURL });
  const sellerPage = await sellerContext.newPage();
  await login(sellerPage, sellerEmail);
  const sellerMe = await sellerPage.request.get('/api/auth/me');
  const sellerId = (await sellerMe.json() as { user: { sellerId: string } }).user.sellerId;
  const method = await sellerPage.request.post('/api/seller/payout-methods', { data: { type: 'MANUAL_BANK', country: 'US', currency: 'USD', label: 'Closeout bank', identifier: 'closeout-account-1234', details: { accountHolder: 'Local Seller' } }, headers: await csrfHeaders(sellerPage) });
  expect(method.status()).toBe(201);
  const methodBody = await method.json() as { id: string; maskedIdentifier: string };
  expect(methodBody.maskedIdentifier).not.toContain('closeout-account-1234');

  const buyerContext = await browser.newContext({ baseURL: e2eBaseURL });
  const buyerPage = await buyerContext.newPage();
  await login(buyerPage, buyerEmail);
  const catalog = await buyerPage.request.get('/api/products?q=Demo%20Canvas%20Tote');
  expect(catalog.ok(), await catalog.text()).toBeTruthy();
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  expect(product?.id).toBeTruthy();
  const added = await buyerPage.request.post('/api/cart/items', { data: { productId: product.id, quantity: 1 }, headers: await csrfHeaders(buyerPage) });
  expect(added.status()).toBe(201);
  const address = { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' };
  const shippingQuote = await buyerPage.request.post('/api/shipping/quote', { data: { address }, headers: await csrfHeaders(buyerPage) });
  expect(shippingQuote.status(), await shippingQuote.text()).toBe(200);
  const shippingBody = await shippingQuote.json() as { quoteToken: string };
  const checkout = await buyerPage.request.post('/api/orders/checkout', { data: { buyerEmail, buyerName: 'Local Buyer', address, method: 'COD', shippingQuoteToken: shippingBody.quoteToken }, headers: await csrfHeaders(buyerPage) });
  const checkoutBody = await checkout.text();
  expect(checkout.status(), `Checkout failed: ${checkoutBody}`).toBe(201);
  const orderId = (JSON.parse(checkoutBody) as { orderId: string }).orderId;
  const collectedBeforeDelivery = await page.request.post(`/api/orders/${orderId}/cod-collect`, { data: {}, headers: await csrfHeaders(page) });
  const earlyCollectionBody = await collectedBeforeDelivery.text();
  expect(collectedBeforeDelivery.status(), earlyCollectionBody).toBe(409);
  expect(JSON.parse(earlyCollectionBody) as { code: string }).toMatchObject({ code: 'COD_DELIVERY_REQUIRED' });
  const orders = await page.request.get('/api/admin/orders');
  const order = (await orders.json() as { id: string; sellerOrders: { id: string; sellerId: string }[] }[]).find(item => item.id === orderId)!;
  const shippingUrl = `/api/sellers/${sellerId}/orders/${order.sellerOrders[0].id}/shipping`;
  for (const status of ['SHIPPED', 'DELIVERED'] as const) {
    const shipment = await sellerPage.request.patch(shippingUrl, { data: { status, carrier: 'Synthetic E2E Courier', trackingNumber: `E2E-${order.sellerOrders[0].id}`, trackingUrl: `https://tracking.example.test/${order.sellerOrders[0].id}`, note: `Synthetic ${status.toLowerCase()} confirmation` }, headers: await csrfHeaders(sellerPage) });
    expect(shipment.status(), await shipment.text()).toBe(200);
  }
  const collected = await page.request.post(`/api/orders/${orderId}/cod-collect`, { data: {}, headers: await csrfHeaders(page) });
  expect(collected.status(), await collected.text()).toBe(200);

  const codLedgerAttempt = await page.request.post(`/api/admin/payout-ledger/reconcile-seller-order/${order.sellerOrders[0].id}`, { data: {}, headers: await csrfHeaders(page) });
  expect(codLedgerAttempt.status()).toBe(409);
  expect((await codLedgerAttempt.json() as { error: string }).error).toContain('COD and POS are not platform-held funds');
  expect(await prisma.sellerPayoutLedgerEntry.count({ where: { sellerOrderId: order.sellerOrders[0].id } })).toBe(0);

  // This is an isolated database fixture for the positive payout branch: COD
  // was first proven ineligible above, then the payment row is set to a
  // synthetic, already-settled Stripe state without contacting any provider.
  await prisma.payment.update({ where: { parentId: orderId }, data: { method: PaymentMethod.STRIPE, status: PaymentStatus.PAID, providerRef: `e2e-settled-${orderId}`, paidAt: new Date() } });
  const receipt = await buyerPage.request.post(`/api/orders/${orderId}/shipments/${order.sellerOrders[0].id}/confirm-received`, { data: {}, headers: await csrfHeaders(buyerPage) });
  expect(receipt.ok(), await receipt.text()).toBeTruthy();

  const ledger = await page.request.post(`/api/admin/payout-ledger/reconcile-seller-order/${order.sellerOrders[0].id}`, { data: {}, headers: await csrfHeaders(page) });
  expect(ledger.status(), await ledger.text()).toBe(201);
  const request = await sellerPage.request.post('/api/seller/payouts/request', { data: { payoutMethodId: methodBody.id }, headers: await csrfHeaders(sellerPage) });
  expect(request.status()).toBe(201);
  const payoutId = (await request.json() as { id: string }).id;
  const approved = await page.request.post(`/api/admin/payouts/${payoutId}/approve`, { data: {}, headers: await csrfHeaders(page) });
  expect(approved.status()).toBe(200);
  const paid = await page.request.post(`/api/admin/payouts/${payoutId}/mark-paid`, { data: { reference: 'LOCAL-CLOSEOUT-REF', evidenceNote: 'Disposable local verification only' }, headers: await csrfHeaders(page) });
  expect(paid.status()).toBe(200);
  await buyerContext.close();
  await sellerContext.close();
});
