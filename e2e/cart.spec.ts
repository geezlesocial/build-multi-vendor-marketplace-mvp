import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';
const buyerEmail = 'buyer.local@example.test';

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

test('buyer can update, remove, and empty the cart without CSRF errors', async ({ page }) => {
  await login(page);
  const catalog = await page.request.get('/api/products?q=Demo%20Canvas%20Tote');
  const product = (await catalog.json() as { items: { id: string }[] }).items[0];
  const headers = await csrfHeaders(page);
  await page.request.patch(`/api/cart/items/${product.id}`, { data: { quantity: 0 }, headers });

  await page.goto('/');
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
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
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  const cartLink = page.getByRole('link', { name: /Cart/ });
  await expect(cartLink).toHaveAttribute('href', '/checkout');
  await cartLink.click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByLabel('Address').fill('1 Test Street');
  await page.getByLabel('City').fill('Test City');
  await page.getByLabel('Region').fill('TS');
  await page.getByLabel('Postal code').fill('1000');
  await page.getByRole('button', { name: 'Place order' }).click();

  const confirmation = page.locator('.orderConfirmation');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Order confirmed');
  await expect(confirmation).toContainText(/MV-\d{8}-[A-Z0-9]+/);
  const confirmationTotal = confirmation.locator('dl div').filter({ hasText: 'Total' }).locator('dd');
  await expect(confirmationTotal).toHaveText('$24.00');
  await expect(confirmation).toContainText('COD (Cash on delivery)');
  await expect(confirmation).toContainText('Pending');
  const summaryTotal = page.locator('.summary .total strong');
  await expect(summaryTotal).toHaveText((await confirmationTotal.textContent())!.trim());
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
  await expect(page.getByText('Added to cart')).not.toBeVisible();
  await expect(page.getByRole('link', { name: /Cart/ })).toContainText('0');
});
