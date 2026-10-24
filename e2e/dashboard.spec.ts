import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test('buyer dashboard exposes buyer modules and denies seller-scoped data', async ({ page }) => {
  await login(page, 'buyer.local@example.test');
  await expect((await page.request.get('/api/dashboard/seller')).status()).toBe(403);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buyer view' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Seller view' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Orders' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cart' })).toBeVisible();
});

test('approved seller can switch dashboards and view only the public store link', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  const storeResponse = await page.request.get('/api/seller/store-theme');
  expect(storeResponse.ok(), await storeResponse.text()).toBeTruthy();
  const store = await storeResponse.json() as { publicPath: string; name: string };

  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Seller view' }).click();
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Store' }).click();
  await expect(page.getByText(store.name)).toBeVisible();
  await expect(page.getByRole('link', { name: 'View store', exact: true })).toHaveAttribute('href', store.publicPath);
  await expect((await page.request.get('/api/dashboard/buyer')).ok()).toBeTruthy();
});

test('seller workspace switching survives direct URLs, refresh, and browser history', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  await page.goto('/dashboard?mode=buyer');
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();

  await page.getByRole('button', { name: 'Seller view' }).click();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller/);
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seller view' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Buyer view' }).click();
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller/);
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
});

test('seller dashboard renders historical gross totals separately with explicit currency codes', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  await page.route('**/api/dashboard/seller', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      store: {},
      summary: { orderCount: 205, grossByCurrency: [{ currency: 'JPY', grossMinor: 2_060_000 }, { currency: 'USD', grossMinor: 1_020_000 }] },
      products: [], orders: [], conversations: [], payoutMethods: [], payouts: [],
      live: { effectiveEnabled: false, deploymentGate: false, reason: 'Disabled for this test.' }
    })
  }));
  await page.goto('/dashboard?mode=seller');
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await expect(page.getByText('Gross sales (JPY): ¥2,060,000', { exact: true })).toBeVisible();
  await expect(page.getByText('Gross sales (USD): $10,200.00', { exact: true })).toBeVisible();
  await expect(page.getByText('$30,800.00', { exact: true })).toHaveCount(0);
});

test('buyer direct seller URL stays on the onboarding path and does not request seller data', async ({ page }) => {
  await login(page, 'buyer.local@example.test');
  let sellerDataRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/dashboard/seller')) sellerDataRequests += 1; });
  await expect((await page.request.get('/api/dashboard/seller')).status()).toBe(403);
  await page.goto('/dashboard?mode=seller');
  await expect(page.getByRole('heading', { name: 'Seller access is not active yet' })).toBeVisible();
  expect(sellerDataRequests).toBe(0);
  await page.getByRole('link', { name: 'Return to buyer workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
});

test('a slower seller response cannot switch away from the buyer workspace', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  await page.goto('/dashboard');
  let releaseSellerResponse!: () => void;
  let signalSellerRequest!: () => void;
  const holdSellerResponse = new Promise<void>(resolve => { releaseSellerResponse = resolve; });
  const sellerRequestStarted = new Promise<void>(resolve => { signalSellerRequest = resolve; });
  await page.route('**/api/dashboard/seller', async route => {
    signalSellerRequest();
    await holdSellerResponse;
    await route.continue();
  });

  await page.getByRole('button', { name: 'Seller view' }).click();
  await sellerRequestStarted;
  await page.getByRole('button', { name: 'Buyer view' }).click();
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  const delayedSellerResponse = page.waitForResponse(response => response.url().endsWith('/api/dashboard/seller'));
  releaseSellerResponse();
  const sellerResponse = await delayedSellerResponse;
  expect(sellerResponse.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  await page.unroute('**/api/dashboard/seller');
  await page.getByRole('button', { name: 'Seller view' }).click();
  await expect(page.getByRole('button', { name: 'Products' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
});

test('seller dashboard reports a failed refresh and supports retry', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  let failedOnce = false;
  await page.route('**/api/dashboard/seller', async route => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary dashboard failure' }) });
      return;
    }
    await route.continue();
  });
  await page.goto('/dashboard?mode=seller');
  await expect(page.getByRole('alert')).toContainText('Temporary dashboard failure');
  await page.getByRole('button', { name: 'Retry seller dashboard' }).click();
  await expect(page.getByRole('button', { name: 'Products' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('buyer and seller workspaces fit a narrow mobile viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'seller.local@example.test');
  await page.goto('/dashboard');
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(pageWidth).toBeLessThanOrEqual(viewportWidth);
  await page.getByRole('button', { name: 'Seller view' }).click();
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
});

test('member homepage cart summary refreshes with the shared cart-change event', async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `dashboard-cart-${suffix}@example.test`;
  const registered = await page.request.post('/api/auth/register', {
    data: { email, name: 'Dashboard Cart Test Member', password }
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const productsResponse = await page.request.get('/api/products');
  expect(productsResponse.ok(), await productsResponse.text()).toBeTruthy();
  const products = (await productsResponse.json() as { items: { id: string; name: string; availableStock: number }[] }).items;
  const product = products.find(item => item.name === 'Demo Canvas Tote' && item.availableStock > 1);
  expect(product, 'the disposable seed should include the approved USD demo tote').toBeTruthy();
  const cartResponse = await page.request.get('/api/cart');
  expect(cartResponse.ok(), await cartResponse.text()).toBeTruthy();
  const cartBefore = await cartResponse.json() as { items: { quantity: number }[] };
  expect(cartBefore.items, 'the newly registered test buyer should have an isolated empty cart').toHaveLength(0);
  const expectedCount = cartBefore.items.reduce((sum, item) => sum + item.quantity, 0) + 1;

  await page.goto('/');
  const productCard = page.locator('article.productCard').filter({ has: page.getByRole('heading', { name: product!.name, exact: true }) });
  await productCard.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: `In your cart: ${expectedCount} items` })).toBeVisible();
  await expect(page.locator('.cartButton b')).toHaveText(String(expectedCount));
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  const removed = await page.request.patch(`/api/cart/items/${product!.id}`, { data: { quantity: 0 }, headers: { 'x-csrf-token': csrf! } });
  expect(removed.status(), await removed.text()).toBe(204);
});

test('admin remains on the separate admin surface and cannot use a buyer/seller dashboard switch', async ({ page }) => {
  await login(page, 'admin.local@example.test');
  const access = await page.request.get('/api/dashboard/access');
  expect(access.ok()).toBeTruthy();
  expect((await access.json()).buyer).toBe(false);
  await expect((await page.request.get('/api/dashboard/buyer')).status()).toBe(403);
  await expect((await page.request.get('/api/dashboard/seller')).status()).toBe(403);
});
