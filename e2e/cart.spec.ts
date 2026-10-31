import { expect, test, type Page } from '@playwright/test';
import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required for cart browser tests.');
const prisma = createTestPrismaClient(databaseUrl);

const password = 'LocalDemoOnly-ChangeMe-123!';
const buyerEmail = 'buyer.local@example.test';

test.afterAll(async () => { await prisma.$disconnect(); });

async function login(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: buyerEmail, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

test('guest is prompted to sign in instead of sending a cart mutation', async ({ page }) => {
  let cartMutationSent = false;
  page.on('request', request => {
    if (request.url().includes('/api/cart/items') && request.method() !== 'GET') cartMutationSent = true;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Add to cart' }).first().click();

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Sign in to add items to your cart.');
  expect(cartMutationSent).toBe(false);
});

test('guest opening a product detail page is sent to sign in without a cart mutation', async ({ page }) => {
  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  expect(catalog.ok(), await catalog.text()).toBeTruthy();
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  expect(product).toBeTruthy();

  let cartMutationSent = false;
  page.on('request', request => {
    if (request.url().includes('/api/cart/items') && request.method() !== 'GET') cartMutationSent = true;
  });

  await page.goto(`/products/${product.id}`);
  await page.getByRole('button', { name: 'Add to cart' }).click();

  await expect(page).toHaveURL(/\/\?auth=login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(cartMutationSent).toBe(false);
});

test('buyer can add to cart from a product detail page and the header count refreshes', async ({ page }) => {
  const suffix = randomUUID();
  const registration = await page.request.post('/api/auth/register', { data: {
    name: 'Product Detail Buyer',
    email: `product-detail-${suffix}@example.test`,
    password
  } });
  expect(registration.status(), await registration.text()).toBe(201);
  const registeredUser = (await registration.json() as { user: { id: string } }).user;
  await prisma.user.update({ where: { id: registeredUser.id }, data: { onboardingCompletedAt: new Date() } });

  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  expect(catalog.ok(), await catalog.text()).toBeTruthy();
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  expect(product).toBeTruthy();

  await page.goto(`/products/${product.id}`);
  const addResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/cart/items' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Add to cart' }).click();
  const addResponse = await addResponsePromise;
  expect(addResponse.status(), await addResponse.text()).toBe(201);
  expect(await addResponse.json()).toMatchObject({ productId: product.id, quantity: 1 });
  await expect(page.locator('.cartButton b')).toHaveText('1');

  const savedCart = await page.request.get('/api/cart');
  expect(savedCart.ok(), await savedCart.text()).toBeTruthy();
  expect(await savedCart.json()).toMatchObject({ items: [expect.objectContaining({ productId: product.id, quantity: 1 })] });
});

test('buyer can update, remove, and empty the cart without CSRF errors', async ({ page }) => {
  await login(page);
  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  const headers = await csrfHeaders(page);
  await page.request.patch(`/api/cart/items/${product.id}`, { data: { quantity: 0 }, headers });

  await page.goto('/');
  const addResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/cart/items' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  const addResponse = await addResponsePromise;
  expect(addResponse.status()).toBe(201);
  expect(await addResponse.json()).toMatchObject({ productId: product.id, quantity: 1 });
  const persistedCartResponse = await page.request.get('/api/cart');
  expect(persistedCartResponse.status()).toBe(200);
  const persistedCart = await persistedCartResponse.json() as { items: { productId: string; quantity: number }[] };
  expect(persistedCart.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ productId: product.id, quantity: 1 })
  ]));

  const cartLink = page.getByRole('link', { name: /Cart/ });
  await expect(cartLink).toHaveAttribute('href', '/checkout');
  await cartLink.click();
  await expect(page).toHaveURL(/\/checkout$/);

  const line = page.locator('.cartLine').filter({ hasText: 'Demo Canvas Tote' });
  await expect(line).toBeVisible();
  await expect(line.getByRole('button', { name: 'Decrease quantity for Demo Canvas Tote' })).toBeDisabled();
  await expect(line.locator('output')).toHaveText('1');
  await expect(line).toContainText('$24.00');
  await expect(page.locator('.total')).toContainText('$24.00');

  await line.getByRole('button', { name: 'Increase quantity for Demo Canvas Tote' }).click();
  await expect(line.locator('output')).toHaveText('2');
  await expect(line).toContainText('$48.00');
  await expect(page.locator('.total')).toContainText('$48.00');

  await line.getByRole('button', { name: 'Decrease quantity for Demo Canvas Tote' }).click();
  await expect(line.locator('output')).toHaveText('1');
  await expect(page.locator('.total')).toContainText('$24.00');

  await line.getByRole('button', { name: 'Remove Demo Canvas Tote from cart' }).click();
  const announcement = page.locator('.shellNotice[role="status"]');
  await expect(announcement).toContainText('Demo Canvas Tote removed from your cart.');
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Cart/ })).toContainText('0');
  await expect(page.locator('.cartLine')).toHaveCount(0);
});

test('buyer sees the COD confirmation after checkout empties the cart', async ({ page }) => {
  await login(page);
  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  const headers = await csrfHeaders(page);
  await page.request.patch(`/api/cart/items/${product.id}`, { data: { quantity: 0 }, headers });

  await page.goto('/');
  const addResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/cart/items' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  const addResponse = await addResponsePromise;
  expect(addResponse.status(), await addResponse.text()).toBe(201);
  await expect(page.locator('.cartButton b')).toHaveText('1');
  const cartLink = page.getByRole('link', { name: /Cart/ });
  await expect(cartLink).toHaveAttribute('href', '/checkout');
  await cartLink.click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByLabel('Address').fill('1 Test Street');
  await page.getByLabel('City').fill('Test City');
  await page.getByLabel('Region').fill('TS');
  await page.getByLabel('Postal code').fill('1000');
  await page.getByRole('button', { name: 'Calculate shipping' }).click();
  const deliveryService = page.getByRole('combobox', { name: 'Delivery service for Demo Store' });
  await expect(deliveryService).toBeVisible();
  await expect(page.locator('.summary .total strong')).toHaveText('$29.00');
  await expect(deliveryService).toHaveValue('local-demo-shipping-service');
  const paymentMethod = page.getByRole('combobox', { name: 'Payment method' });
  await expect(paymentMethod.locator('option[value="COD"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Place order' }).click();

  const confirmation = page.locator('.orderConfirmation');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Order received');
  await expect(confirmation).toContainText(/MV-\d{8}-[A-Z0-9]+/);
  const confirmationTotal = confirmation.locator('dl div').filter({ hasText: 'Total' }).locator('dd');
  await expect(confirmationTotal).toHaveText('$29.00');
  await expect(confirmation).toContainText('COD (Cash on delivery)');
  await expect(confirmation).toContainText('Pending');
  const summaryTotal = page.locator('.summary .total strong');
  await expect(summaryTotal).toHaveText((await confirmationTotal.textContent())!.trim());
  await expect(page.locator('.summary')).toContainText('Standard local delivery');
  await expect(page.locator('.summary')).toContainText('$5.00');
  const emptiedCartResponse = await page.request.get('/api/cart');
  expect(emptiedCartResponse.ok(), await emptiedCartResponse.text()).toBeTruthy();
  expect((await emptiedCartResponse.json() as { items: unknown[] }).items).toHaveLength(0);
  await expect(page.getByText('Added to cart')).not.toBeVisible();
  await expect(page.getByRole('link', { name: /Cart/ })).toContainText('0');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
