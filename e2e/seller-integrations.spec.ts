import { expect, test, type Page } from '@playwright/test';

const sellerEmail = 'seller.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const password = 'LocalDemoOnly-ChangeMe-123!';

async function signIn(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), `Synthetic fixture login failed with ${response.status()}.`).toBeTruthy();
}

test('seller integrations preserve seller plan gates and grant the official admin Store premium access', async ({ page, browser }) => {
  await signIn(page, sellerEmail);
  const response = await page.request.get('/api/seller/integrations');
  expect(response.ok(), await response.text()).toBeTruthy();
  const integrations = await response.json() as {
    customDomain: { eligible: boolean; targetConfigured: boolean };
    email: { eligible: boolean; active: boolean };
    providers: { id: string }[];
  };
  expect(integrations.customDomain.eligible).toBe(false);
  expect(integrations.email.eligible).toBe(false);
  expect(integrations.providers.map(provider => provider.id)).toEqual(expect.arrayContaining(['ZOHO', 'NAMECHEAP', 'MANUAL_SMTP']));

  await page.goto('/dashboard?mode=seller&tab=integrations');
  await expect(page.getByRole('heading', { name: 'Custom domain' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect an SMTP provider' })).toBeVisible();
  await expect(page.getByText(/Custom domains require a paid Store Plan/)).toBeVisible();
  await expect(page.getByText(/Seller SMTP requires a paid Store Plan/)).toBeVisible();

  const admin = await browser.newPage();
  try {
    await signIn(admin, 'admin.local@example.test');
    const adminResponse = await admin.request.get('/api/seller/integrations');
    expect(adminResponse.ok(), await adminResponse.text()).toBeTruthy();
    const adminIntegrations = await adminResponse.json() as {
      platformAdminOverride: boolean;
      customDomain: { eligible: boolean };
      email: { eligible: boolean };
    };
    expect(adminIntegrations).toMatchObject({
      platformAdminOverride: true,
      customDomain: { eligible: true },
      email: { eligible: true }
    });

    await admin.goto('/dashboard?mode=seller&tab=integrations');
    await expect(admin.getByText(/Official marketplace Store: all Store Plan premium features are enabled/)).toBeVisible();
    await expect(admin.getByRole('combobox', { name: 'Email provider' })).toBeVisible();
    await expect(admin.getByText(/Custom domains require a paid Store Plan/)).toHaveCount(0);
    await expect(admin.getByText(/Seller SMTP requires a paid Store Plan/)).toHaveCount(0);
  } finally {
    await admin.close();
  }

  const buyer = await browser.newPage();
  try {
    await signIn(buyer, buyerEmail);
    expect((await buyer.request.get('/api/seller/integrations')).status()).toBe(403);
  } finally {
    await buyer.close();
  }
});
