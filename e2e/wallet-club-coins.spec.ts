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

test('buyer wallet and Club Coins surfaces remain visible but money movement is fail-closed', async ({ page }) => {
  await login(page, 'buyer.local@example.test');

  const wallet = await page.request.get('/api/wallet');
  expect(wallet.ok(), await wallet.text()).toBeTruthy();
  const walletBody = await wallet.json() as { gates: { moneyMovementHardDisabled: boolean; walletFundingEnabled: boolean; walletTransfersEnabled: boolean; walletWithdrawalsEnabled: boolean; walletCheckoutEnabled: boolean } };
  expect(walletBody.gates).toMatchObject({ moneyMovementHardDisabled: true, walletFundingEnabled: false, walletTransfersEnabled: false, walletWithdrawalsEnabled: false, walletCheckoutEnabled: false });

  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/wallet/funding-intents', { data: { amountMinor: 100, currency: 'USD', provider: 'LOCAL_TEST', idempotencyKey: 'e2e-wallet-funding-1' }, headers })).status()).toBe(409);
  expect((await page.request.post('/api/wallet/transfers', { data: { recipientEmail: 'seller.local@example.test', amountMinor: 100, currency: 'USD', idempotencyKey: 'e2e-wallet-transfer-1' }, headers })).status()).toBe(409);
  expect((await page.request.post('/api/wallet/withdrawals', { data: { amountMinor: 100, currency: 'USD', destinationType: 'APPROVED_PAYOUT_METHOD', idempotencyKey: 'e2e-wallet-withdrawal-1' }, headers })).status()).toBe(409);
  expect((await page.request.post('/api/wallet/checkout-authorize', { data: {}, headers })).status()).toBe(409);

  await page.goto('/wallet');
  await expect(page.getByRole('heading', { name: 'eWallet', exact: true })).toBeVisible();
  await expect(page.getByText('Real-money wallet movement is disabled by server policy.')).toBeVisible();
  await page.goto('/club-coins');
  await expect(page.getByRole('heading', { name: 'Club Coins', exact: true })).toBeVisible();
  await expect(page.getByText('Club Coins are currently disabled.')).toBeVisible();
});

test('only an administrator can view wallet policy controls', async ({ page, browser }) => {
  await login(page, 'buyer.local@example.test');
  expect((await page.request.get('/api/admin/wallet/summary')).status()).toBe(403);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await login(adminPage, 'admin.local@example.test');
  const summary = await adminPage.request.get('/api/admin/wallet/summary');
  expect(summary.ok(), await summary.text()).toBeTruthy();
  expect((await summary.json()).gates.moneyMovementHardDisabled).toBe(true);
  await adminPage.goto('/admin/wallet');
  await expect(adminPage.getByRole('heading', { name: 'Wallet administration' })).toBeVisible();
  await expect(adminPage.getByText('Real-money wallet movement is hard-disabled by server configuration.')).toBeVisible();
  await adminContext.close();
});
