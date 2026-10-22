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

test('admin remains on the separate admin surface and cannot use a buyer/seller dashboard switch', async ({ page }) => {
  await login(page, 'admin.local@example.test');
  const access = await page.request.get('/api/dashboard/access');
  expect(access.ok()).toBeTruthy();
  expect((await access.json()).buyer).toBe(false);
  await expect((await page.request.get('/api/dashboard/buyer')).status()).toBe(403);
  await expect((await page.request.get('/api/dashboard/seller')).status()).toBe(403);
});
