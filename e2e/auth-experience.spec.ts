import { PrismaClient } from '@prisma/client';
import { expect, test, type Page } from '@playwright/test';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const adminEmail = 'admin.local@example.test';
const password = 'LocalDemoOnly-ChangeMe-123!';
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; authentication tests must use the disposable E2E database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

test.beforeAll(async () => {
  await prisma.authPageCustomization.deleteMany();
  await prisma.socialLoginProviderConfiguration.deleteMany({ where: { provider: 'X' } });
});

test.afterEach(async () => {
  await prisma.authPageCustomization.deleteMany();
  await prisma.socialLoginProviderConfiguration.deleteMany({ where: { provider: 'X' } });
});

async function signIn(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: adminEmail, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.afterAll(async () => prisma.$disconnect());

test('sign-in and sign-up pages let users reveal and hide their password', async ({ page }) => {
  await page.goto('/?auth=login');
  const passwordField = page.getByRole('textbox', { name: 'Password', exact: true });
  await expect(passwordField).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordField).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(passwordField).toHaveAttribute('type', 'password');

  await page.getByRole('button', { name: 'Need an account? Create one' }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expect(passwordField).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordField).toHaveAttribute('type', 'text');
  await expect(page.getByLabel('Name')).toBeVisible();
});

test('admin can securely configure a provider and customize account entry pages', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/platform?section=auth');
  await expect(page.getByRole('heading', { name: 'Sign-in & social login', exact: true })).toBeVisible();

  const xCard = page.locator('.adminSocialProvider').filter({ has: page.getByRole('heading', { name: 'X', exact: true }) });
  const providerSecret = 'synthetic-e2e-x-provider-secret-only';
  await xCard.getByLabel('OAuth client ID').fill('synthetic-e2e-x-client');
  await xCard.getByLabel('OAuth client secret').fill(providerSecret);
  await xCard.getByLabel('Enable X sign-in').check();
  await xCard.getByRole('button', { name: 'Save provider settings' }).click();
  await expect(xCard.getByText('Active', { exact: true })).toBeVisible();

  const storedProvider = await prisma.socialLoginProviderConfiguration.findUnique({ where: { provider: 'X' } });
  expect(storedProvider?.enabled).toBe(true);
  expect(storedProvider?.clientSecretCiphertext).toBeTruthy();
  expect(storedProvider?.clientSecretCiphertext).not.toContain(providerSecret);
  const publicProviders = await page.request.get('/api/auth/social/providers');
  expect(publicProviders.ok()).toBeTruthy();
  expect((await publicProviders.json() as { providers: { id: string }[] }).providers).toContainEqual(expect.objectContaining({ id: 'X' }));

  await page.getByLabel('Sign-in heading').fill('Welcome back to Market Lane');
  await page.getByLabel('Sign-up heading').fill('Join Market Lane today');
  await page.getByLabel('Page layout').selectOption('SPLIT');
  await page.getByLabel('Motion style').selectOption('SLIDE');
  await page.getByRole('button', { name: 'Save sign-in appearance' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'saved and active immediately' })).toBeVisible();

  await page.goto('/?auth=login');
  await expect(page.getByRole('heading', { name: 'Welcome back to Market Lane' })).toBeVisible();
  await expect(page.locator('.authPage')).toHaveClass(/authLayout-split/);
  await expect(page.locator('.authPage')).toHaveClass(/authMotion-slide/);
  await expect(page.getByRole('link', { name: 'Continue with X' })).toBeVisible();
  await page.getByRole('button', { name: 'Need an account? Create one' }).click();
  await expect(page.getByRole('heading', { name: 'Join Market Lane today' })).toBeVisible();
});
