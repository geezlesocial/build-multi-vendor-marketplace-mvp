import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';

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

test('seller workspace exposes dropshipping and clearly enforces paid-plan eligibility', async ({ page }) => {
  await login(page, 'seller.local@example.test');
  const endpoint = await page.request.get('/api/seller/dropshipping');
  expect(endpoint.status()).toBe(403);
  await expect(endpoint.json()).resolves.toMatchObject({ error: expect.stringContaining('active paid Store plan') });

  await page.goto('/dashboard?mode=seller&tab=dropshipping');
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dropshipping', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Dropshipping', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review Store plan' })).toHaveAttribute('href', '/seller/plan');
});

test('admin can use the supplier module on the official Store without a paid plan', async ({ page }) => {
  await login(page, 'admin.local@example.test');

  const officialStoreResponse = await page.request.get('/api/admin/platform-store');
  expect(officialStoreResponse.ok(), await officialStoreResponse.text()).toBeTruthy();
  const officialStore = await officialStoreResponse.json() as { store: { id: string } | null };
  if (!officialStore.store) {
    const created = await page.request.post('/api/admin/platform-store', {
      data: {
        name: 'E2E Official Store',
        slug: 'e2e-official-store',
        description: 'Disposable integration-test Store',
        baseCurrency: 'USD'
      },
      headers: await csrfHeaders(page)
    });
    expect(created.status(), await created.text()).toBe(201);
  }

  const dropshipping = await page.request.get('/api/seller/dropshipping');
  expect(dropshipping.ok(), await dropshipping.text()).toBeTruthy();
  const dropshippingBody = await dropshipping.json() as { entitlement: { enabled: boolean; adminOverride: boolean; requiresSubscription: boolean }; providers: { code: string; apiReady: boolean; status?: string }[] };
  expect(dropshippingBody.entitlement).toMatchObject({ enabled: true, adminOverride: true, requiresSubscription: false });
  expect(dropshippingBody.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'CJ_DROPSHIPPING', apiReady: true }),
    expect.objectContaining({ code: 'ALIEXPRESS', apiReady: false, status: 'APPROVAL_REQUIRED' }),
    expect.objectContaining({ code: 'ALIBABA_COM', apiReady: false, status: 'APPROVAL_REQUIRED' })
  ]));

  await page.goto('/admin/platform?section=platform-store');
  await expect(page.getByRole('heading', { name: 'Official platform Store' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dropshipping suppliers' })).toBeVisible();
  await expect(page.getByText('Unlimited admin access')).toBeVisible();
});
