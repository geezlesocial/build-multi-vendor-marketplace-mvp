import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import { expect, test, type Page } from '@playwright/test';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const adminEmail = 'admin.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const password = 'LocalDemoOnly-ChangeMe-123!';
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; provider admin tests must use the disposable E2E database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

async function signIn(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name === 'marketplace_csrf');
  expect(cookie).toBeTruthy();
  return { 'x-csrf-token': cookie!.value };
}

test.afterAll(async () => prisma.$disconnect());

test('admin integrations are grouped, role-protected, reference-only, audited, and archive-preserving', async ({ page, browser }) => {
  await signIn(page, adminEmail);
  await page.goto('/admin/platform?section=providers');
  await expect(page.getByRole('heading', { name: 'Control center' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Platform administration sections' });
  await expect(navigation.getByRole('heading', { name: 'Marketplace' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Provider configurations', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('button', { name: 'Live shopping', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Provider configurations', exact: true })).toBeVisible();
  await expect(page.getByText(/Stripe test-mode Store billing is disabled by default/)).toBeVisible();
  const integrationStatus = await page.request.get('/api/admin/integrations');
  expect(integrationStatus.ok()).toBeTruthy();
  expect(await integrationStatus.json()).toMatchObject({ storeBillingSandbox: { enabled: false, liveBillingEnabled: false } });

  const csrf = await csrfHeaders(page);
  const buyerContext = await browser.newContext();
  const buyer = await buyerContext.newPage();
  await signIn(buyer, buyerEmail);
  expect((await buyer.request.get('/api/admin/integrations')).status()).toBe(403);
  expect((await buyer.request.post('/api/admin/integrations', { data: { provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'SANDBOX', name: 'Denied test config', credentialReferences: {}, reason: 'Role check' }, headers: await csrfHeaders(buyer) })).status()).toBe(403);
  expect((await buyer.request.patch('/api/admin/integrations/payment-methods/COD', { data: { enabled: false, reason: 'Denied test change' }, headers: await csrfHeaders(buyer) })).status()).toBe(403);
  await buyerContext.close();

  const unsupported = await page.request.post('/api/admin/integrations', { data: { provider: 'STRIPE', context: 'STORE_SUBSCRIPTION', environment: 'SANDBOX', name: 'Unsupported', credentialReferences: {}, reason: 'Reject unsupported context' }, headers: csrf });
  expect(unsupported.status()).toBe(400);
  const unsupportedPair = await page.request.post('/api/admin/integrations', { data: { provider: 'PAYPAL', context: 'WALLET_FUNDING', environment: 'SANDBOX', name: 'Unsupported provider pair', credentialReferences: {}, reason: 'Reject unsupported provider context' }, headers: csrf });
  expect(unsupportedPair.status()).toBe(400);
  const arbitraryUrl = await page.request.post('/api/admin/integrations', { data: { provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'SANDBOX', name: 'Reject adapter URL', credentialReferences: { adapterUrl: 'https://adapter.invalid' }, reason: 'Reject arbitrary adapter URL' }, headers: csrf });
  expect(arbitraryUrl.status()).toBe(400);
  const rawSecret = await page.request.post('/api/admin/integrations', { data: { provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'SANDBOX', name: 'Reject raw credential', credentialReferences: { apiSecret: ['sk', 'test', 'synthetic_admin_value_123456'].join('_') }, reason: 'Reject raw credential value' }, headers: csrf });
  expect(rawSecret.status()).toBe(400);

  const syntheticKey = ['sk', 'test', 'synthetic_admin_audit_value_123456'].join('_');
  const create = await page.request.post('/api/admin/integrations', {
    data: {
      provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'SANDBOX', name: 'E2E Stripe checkout inventory',
      credentialReferences: { apiSecret: 'env:STRIPE_SECRET_KEY' }, reason: `Rotation note ${syntheticKey}`
    }, headers: csrf
  });
  expect(create.status(), await create.text()).toBe(201);
  const created = await create.json() as { id: string; enabled: boolean; readiness: { ready: boolean }; credentialReferences: { key: string; maskedReference: string | null }[] };
  expect(created.enabled).toBe(false);
  expect(created.readiness.ready).toBe(false);
  expect(JSON.stringify(created)).not.toContain('env:STRIPE_SECRET_KEY');
  expect(JSON.stringify(created)).not.toContain(syntheticKey);
  const duplicate = await page.request.post('/api/admin/integrations', { data: { provider: 'STRIPE', context: 'MARKETPLACE_CHECKOUT', environment: 'SANDBOX', name: 'Duplicate configuration', credentialReferences: {}, reason: 'Reject duplicate active configuration' }, headers: csrf });
  expect(duplicate.status()).toBe(409);

  const enableIncomplete = await page.request.patch(`/api/admin/integrations/${created.id}/enabled`, { data: { enabled: true, reason: 'Must remain blocked without all credential references' }, headers: csrf });
  expect(enableIncomplete.status()).toBe(409);
  const edit = await page.request.patch(`/api/admin/integrations/${created.id}`, {
    data: { credentialReferences: { webhookSecret: 'secret-ref:payments/stripe/webhookSecret' }, reason: 'Add webhook reference' }, headers: csrf
  });
  expect(edit.status(), await edit.text()).toBe(200);
  expect(await edit.text()).not.toContain('secret-ref:payments/stripe/webhookSecret');

  await page.getByRole('button', { name: 'Payment methods' }).click();
  await expect(page.getByRole('heading', { name: 'Buyer payment methods' })).toBeVisible();
  await expect(page.getByText('COD', { exact: true })).toBeVisible();
  const methodBefore = await page.request.get('/api/admin/integrations');
  const methodData = await methodBefore.json() as { paymentMethods: { method: string; enabled: boolean }[] };
  const codBefore = methodData.paymentMethods.find(item => item.method === 'COD')?.enabled;
  expect(codBefore).toBe(true);
  const reasonField = page.getByRole('textbox', { name: 'Reason for administrative changes' });
  await reasonField.fill('Disposable admin integration E2E switch check');
  const codRow = page.locator('.setting').filter({ hasText: /^COD/ });
  for (const [nextEnabled, buttonName] of [[false, 'Disable'], [true, 'Enable']] as const) {
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain(`${nextEnabled ? 'Enable' : 'Disable'} COD`);
      void dialog.accept();
    });
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/integrations/payment-methods/COD' && response.request().method() === 'PATCH');
    await codRow.getByRole('button', { name: buttonName, exact: true }).click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(200);
    await expect(codRow.getByText(`New transactions: ${nextEnabled ? 'enabled' : 'disabled'} by marketplace setting.`)).toBeVisible();
  }

  await page.getByRole('button', { name: 'Provider configurations' }).click();
  const archived = await page.request.post(`/api/admin/integrations/${created.id}/archive`, { data: { reason: 'Archive disposable test configuration' }, headers: csrf });
  expect(archived.status()).toBe(200);
  const archivedBody = await archived.json() as { archivedAt: string | null; enabled: boolean };
  expect(archivedBody.archivedAt).toBeTruthy();
  expect(archivedBody.enabled).toBe(false);

  const stored = await prisma.providerConfiguration.findUnique({ where: { id: created.id }, include: { credentials: true } });
  expect(stored?.archivedAt).toBeTruthy();
  expect(stored?.credentials).toHaveLength(2);
  const audits = await prisma.auditLog.findMany({ where: { entity: 'ProviderConfiguration', entityId: created.id }, orderBy: { createdAt: 'asc' } });
  expect(audits.map(entry => entry.action)).toEqual(expect.arrayContaining(['PROVIDER_CONFIGURATION_CREATED', 'PROVIDER_CONFIGURATION_UPDATED', 'PROVIDER_CONFIGURATION_ARCHIVED']));
  const auditText = JSON.stringify(audits.map(entry => entry.metadata));
  expect(auditText).not.toContain('env:STRIPE_SECRET_KEY');
  expect(auditText).not.toContain('secret-ref:payments/stripe/webhookSecret');
  expect(auditText).not.toContain(syntheticKey);
  expect(auditText).toContain('[REDACTED]');
  expect(await prisma.auditLog.count({ where: { action: 'PAYMENT_METHOD_CHANGED', entityId: 'COD' } })).toBeGreaterThan(0);
  const codAfter = (await (await page.request.get('/api/admin/integrations')).json() as typeof methodData).paymentMethods.find(item => item.method === 'COD')?.enabled;
  expect(codAfter).toBe(codBefore);

  const noHardDelete = await prisma.providerConfiguration.findUnique({ where: { id: created.id } });
  expect(noHardDelete).not.toBeNull();

  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  await signIn(seller, 'seller.local@example.test');
  const subscribe = await seller.request.post('/api/seller/billing/subscribe', { data: {}, headers: await csrfHeaders(seller) });
  expect(subscribe.status()).toBe(503);
  expect(await subscribe.json()).toMatchObject({ code: 'PLAN_BILLING_DISABLED' });
  await sellerContext.close();
});
