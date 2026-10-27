import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

test('guest can search labeled public catalog results and open a product', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A more thoughtful way to shop independent stores.' })).toBeVisible();
  const home = await page.request.get('/api/marketplace/home');
  expect(home.ok()).toBeTruthy();
  const homeBody = await home.json() as { featuredDeals: { name: string }[]; featuredStores: { name: string }[] };
  expect(homeBody.featuredDeals.every(product => product.name)).toBe(true);
  expect(homeBody.featuredStores.every(store => store.name)).toBe(true);

  const search = page.getByRole('textbox', { name: 'Search products and stores' });
  await search.fill('Demo');
  await expect(page.getByRole('option').first()).toContainText('Product');
  await expect(page.getByRole('option').first()).toContainText('Demo Canvas Tote');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/products\//);
});

test('account preferences persist without allowing unconfigured currency conversion', async ({ page }) => {
  await login(page, 'buyer.local@example.test');
  const headers = await csrfHeaders(page);
  await page.request.patch('/api/account/preferences', { data: { language: 'en' }, headers });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Language and currency' })).toBeVisible();
  try {
    const language = page.getByLabel('Language');
    await language.selectOption('fil');
    await expect(page.getByRole('heading', { name: 'Mga setting' })).toBeVisible();

    const rejected = await page.request.patch('/api/account/preferences', { data: { displayCurrency: 'EUR' }, headers });
    expect(rejected.status()).toBe(409);
    const saved = await page.request.get('/api/account/preferences');
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).preference.language).toBe('fil');

    const buyerAvailability = await page.request.get('/api/admin/platform/availability');
    expect(buyerAvailability.status()).toBe(403);
  } finally {
    await page.request.patch('/api/account/preferences', { data: { language: 'en' }, headers });
  }
});

test('admin availability is protected and exposes only approved, rate-backed display currencies', async ({ page }) => {
  await login(page, 'admin.local@example.test');
  const response = await page.request.get('/api/admin/platform/availability');
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { baseCurrency: string; availableDisplayCurrencies: string[]; fxRatesConfigured: boolean };
  expect(body.baseCurrency).toBeTruthy();
  expect(body.availableDisplayCurrencies).toContain(body.baseCurrency);
  expect(new Set(body.availableDisplayCurrencies).size).toBe(body.availableDisplayCurrencies.length);
  expect(body.fxRatesConfigured).toBe(body.availableDisplayCurrencies.some(code => code !== body.baseCurrency));

  const catalogResponse = await page.request.get('/api/currencies');
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json() as { currencies: { code: string; active: boolean; displayEnabled: boolean }[] };
  for (const code of body.availableDisplayCurrencies) {
    const entry = catalog.currencies.find(currency => currency.code === code);
    expect(entry, `Currency ${code} must exist in the public currency catalog`).toBeTruthy();
    expect(entry).toMatchObject({ active: true, displayEnabled: true });
  }
});
