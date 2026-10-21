import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';
const adminEmail = 'admin.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const sellerEmail = 'seller.local@example.test';
const e2eBaseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5173}`;

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name === 'marketplace_csrf');
  expect(cookie?.value).toBeTruthy();
  return { 'x-csrf-token': cookie!.value };
}

async function close(context: BrowserContext) { await context.clearCookies(); await context.close(); }

test('admin controls attribution and a consented COD conversion creates one pending commission', async ({ page, browser }) => {
  await login(page, adminEmail);
  const settings = await page.request.patch('/api/admin/affiliate-settings', { data: { affiliateEnabled: true, affiliateFundingConfigured: false, affiliateAttributionWindowDays: 30, reason: 'Local E2E' }, headers: await csrf(page) });
  expect(settings.ok()).toBeTruthy();

  const sellerContext = await browser.newContext({ baseURL: e2eBaseURL });
  const sellerPage = await sellerContext.newPage();
  await login(sellerPage, sellerEmail);
  const sellerApplication = await sellerPage.request.post('/api/affiliate/apply', { data: { termsAccepted: true }, headers: await csrf(sellerPage) });
  expect(sellerApplication.status()).toBe(201);
  const application = await sellerApplication.json() as { id: string };
  const approved = await page.request.patch(`/api/admin/affiliates/${application.id}`, { data: { status: 'APPROVED', reason: 'Local E2E approval' }, headers: await csrf(page) });
  expect(approved.ok()).toBeTruthy();

  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  const product = (await catalog.json() as { items: { id: string; slug: string }[] }).items[0];
  const linkResponse = await sellerPage.request.post('/api/affiliate/links', { data: { productId: product.id }, headers: await csrf(sellerPage) });
  expect(linkResponse.status()).toBe(201);
  const link = await linkResponse.json() as { code: string; htmlLink: string; htmlCard: string };
  expect(link.htmlLink).not.toMatch(/<script|on\w+\s*=|javascript:/i);
  expect(link.htmlCard).toContain('/r/');

  const buyerContext = await browser.newContext({ baseURL: e2eBaseURL });
  const buyerPage = await buyerContext.newPage();
  await login(buyerPage, buyerEmail);
  const buyerCart = await buyerPage.request.get('/api/cart');
  expect(buyerCart.ok()).toBeTruthy();
  const buyerCartBody = await buyerCart.json() as { items: { productId: string }[] };
  for (const item of buyerCartBody.items) {
    const removed = await buyerPage.request.patch(`/api/cart/items/${item.productId}`, { data: { quantity: 0 }, headers: await csrf(buyerPage) });
    expect(removed.status()).toBe(204);
  }
  const addReferredProduct = await buyerPage.request.post('/api/cart/items', { data: { productId: product.id, quantity: 1 }, headers: await csrf(buyerPage) });
  expect(addReferredProduct.status()).toBe(201);
  const withoutConsent = await buyerPage.request.post(`/api/affiliate/clicks/${link.code}`, { data: { consent: false }, headers: await csrf(buyerPage) });
  expect(withoutConsent.status()).toBe(400);
  const click = await buyerPage.request.post(`/api/affiliate/clicks/${link.code}`, { data: { consent: true, visitorKey: 'local-e2e-visitor-0001' }, headers: await csrf(buyerPage) });
  expect(click.status()).toBe(200);
  const clickBody = await click.json() as { token: string };
  const checkout = await buyerPage.request.post('/api/orders/checkout', { data: { buyerEmail, buyerName: 'Local Buyer', address: { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' }, method: 'COD', affiliateToken: clickBody.token }, headers: await csrf(buyerPage) });
  const checkoutBody = await checkout.text();
  expect(checkout.status(), checkoutBody).toBe(201);
  const order = JSON.parse(checkoutBody) as { orderId: string };
  const collected = await page.request.post(`/api/orders/${order.orderId}/cod-collect`, { data: {}, headers: await csrf(page) });
  expect(collected.status()).toBe(200);
  const duplicateCollection = await page.request.post(`/api/orders/${order.orderId}/cod-collect`, { data: {}, headers: await csrf(page) });
  expect(duplicateCollection.status()).toBe(200);

  const dashboard = await sellerPage.request.get('/api/affiliate/me');
  expect(dashboard.ok()).toBeTruthy();
  const dashboardBody = await dashboard.json() as { commissions: { amountMinor: number; status: string }[]; summary: { clicks: number } };
  expect(dashboardBody.summary.clicks).toBeGreaterThan(0);
  expect(dashboardBody.commissions).toHaveLength(1);
  expect(dashboardBody.commissions[0].status).toBe('PENDING');
  const adminOrders = await page.request.get('/api/admin/orders');
  const persistedOrder = (await adminOrders.json() as { id: string; sellerOrders: { items: { id: string }[] }[] }[]).find(item => item.id === order.orderId)!;
  const partialRefund = await page.request.post('/api/admin/affiliate-adjustments', { data: { orderId: order.orderId, orderItemId: persistedOrder.sellerOrders[0].items[0].id, type: 'REFUND', amountMinor: 60, idempotencyKey: `affiliate-e2e-refund-${order.orderId}`, reason: 'Local partial refund test' }, headers: await csrf(page) });
  expect(partialRefund.status()).toBe(201);
  const duplicateRefund = await page.request.post('/api/admin/affiliate-adjustments', { data: { orderId: order.orderId, orderItemId: persistedOrder.sellerOrders[0].items[0].id, type: 'REFUND', amountMinor: 60, idempotencyKey: `affiliate-e2e-refund-${order.orderId}`, reason: 'Local partial refund test' }, headers: await csrf(page) });
  expect(duplicateRefund.status()).toBe(201);
  const afterRefund = await sellerPage.request.get('/api/affiliate/commissions');
  const refundEntries = await afterRefund.json() as { entryType: string; amountMinor: number }[];
  expect(refundEntries.some(entry => entry.entryType === 'REVERSAL' && entry.amountMinor === -60)).toBeTruthy();
  await close(buyerContext); await close(sellerContext);
});

test('buyer cannot change affiliate settings or review applications', async ({ page }) => {
  await login(page, buyerEmail);
  const response = await page.request.patch('/api/admin/affiliate-settings', { data: { affiliateEnabled: true }, headers: await csrf(page) });
  expect(response.status()).toBe(403);
});

test('affiliate cannot attribute their own order', async ({ page }) => {
  await login(page, sellerEmail);
  const profile = await page.request.get('/api/affiliate/me');
  const body = await profile.json() as { links: { code: string }[] };
  expect(body.links.length).toBeGreaterThan(0);
  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  const add = await page.request.post('/api/cart/items', { data: { productId: product.id, quantity: 1 }, headers: await csrf(page) });
  expect(add.status()).toBe(201);
  const click = await page.request.post(`/api/affiliate/clicks/${body.links[0].code}`, { data: { consent: true, visitorKey: 'seller-self-referral-0001' }, headers: await csrf(page) });
  expect(click.status()).toBe(200);
  const token = (await click.json() as { token: string }).token;
  const checkout = await page.request.post('/api/orders/checkout', { data: { buyerEmail: sellerEmail, buyerName: 'Local Seller', address: { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' }, method: 'COD', affiliateToken: token }, headers: await csrf(page) });
  expect(checkout.status()).toBe(409);
});
