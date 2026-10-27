import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL must point to the disposable browser-test database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const password = 'Onboarding-E2E-Only-Password-42!';
const demoPassword = 'LocalDemoOnly-ChangeMe-123!';
const createdStores: string[] = [];

async function createStoreFixture(label: string, status: SellerStatus) {
  const suffix = randomUUID();
  const template = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const user = await prisma.user.create({ data: { email: `onboarding-${label}-${suffix}@example.test`, name: `Onboarding ${label}`, role: Role.SELLER, passwordHash: template.passwordHash, onboardingCompletedAt: new Date() } });
  const seller = await prisma.seller.create({ data: { userId: user.id, status } });
  const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Onboarding ${label} ${suffix.slice(0, 6)}`, slug: `onboarding-${label}-${suffix}`, description: 'Synthetic eligible-store fixture for onboarding tests.' } });
  createdStores.push(store.id);
  const type = await prisma.catalogProductType.findUniqueOrThrow({ where: { slug: 'physical-product' }, select: { id: true } });
  await prisma.product.create({ data: {
    sellerId: seller.id,
    productTypeId: type.id,
    name: `Onboarding product ${label} ${suffix.slice(0, 6)}`,
    slug: `onboarding-product-${label}-${suffix}`,
    description: 'Synthetic approved item used only by isolated onboarding browser tests.',
    priceMinor: 1200,
    currency: 'USD',
    status: ProductStatus.APPROVED,
    inventory: { create: { quantity: 5 } }
  } });
  return store;
}

async function ensureOfficialStoreFixture() {
  const existing = await prisma.store.findFirst({ where: { isPlatformStore: true }, select: { id: true, sellerId: true } });
  if (existing) return existing;

  const suffix = randomUUID();
  const template = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const user = await prisma.user.create({ data: { email: `onboarding-official-${suffix}@example.test`, name: 'Onboarding Official Store Owner', role: Role.SELLER, passwordHash: template.passwordHash, onboardingCompletedAt: new Date() } });
  const seller = await prisma.seller.create({ data: { userId: user.id, status: SellerStatus.APPROVED } });
  const store = await prisma.store.create({ data: { sellerId: seller.id, isPlatformStore: true, name: `Official Platform Store ${suffix.slice(0, 6)}`, slug: `onboarding-official-${suffix}`, description: 'Official platform store used to verify onboarding recommendations.' } });
  createdStores.push(store.id);
  return { id: store.id, sellerId: store.sellerId };
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

async function registerApiAccount(page: Page, label: string) {
  const email = `${label}-${randomUUID()}@example.test`;
  const response = await page.request.post('/api/auth/register', { data: { email, name: 'Onboarding Test Member', password } });
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json() as { user: { id: string; onboardingCompletedAt: string | null } };
  expect(body.user.onboardingCompletedAt).toBeNull();
  return { email, userId: body.user.id };
}

test.beforeAll(async () => {
  await createStoreFixture('Approved-A', SellerStatus.APPROVED);
  await createStoreFixture('Approved-B', SellerStatus.APPROVED);
  await createStoreFixture('Suspended', SellerStatus.SUSPENDED);
  await ensureOfficialStoreFixture();
});

test.afterAll(async () => { await prisma.$disconnect(); });

test('new signup is guided through persistent onboarding before entering the member home', async ({ page }) => {
  const email = `onboarding-ui-${randomUUID()}@example.test`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?auth=register');
  await page.getByLabel('Name', { exact: true }).fill('New Onboarding Member');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: /Welcome to/ })).toBeVisible();
  await expect(page.getByText('New Onboarding Member', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose stores to follow' })).toBeVisible();
  const firstRecommendedStore = page.locator('.onboardingStoreCard').first();
  await expect(firstRecommendedStore).toHaveClass(/isOfficial/);
  await expect(firstRecommendedStore.getByText('Official platform store', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose your default currency' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where did you hear about us?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete onboarding & continue' })).toBeDisabled();
  const onboarding = await page.request.get('/api/onboarding');
  expect(onboarding.ok(), await onboarding.text()).toBeTruthy();
  const initial = await onboarding.json() as { stores: { id: string }[]; currencies: { code: string }[]; defaultCurrency: string };
  expect(initial.stores.length).toBeGreaterThanOrEqual(2);
  expect(initial.stores.length).toBeLessThanOrEqual(8);
  expect(initial.currencies.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));

  const followButtons = page.getByRole('button', { name: 'Follow', exact: true });
  await followButtons.nth(0).click();
  await expect(page.locator('.onboardingFollowCount strong')).toContainText('1 of');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Follow', exact: true }).first().click();
  await expect(page.locator('.onboardingFollowCount strong')).toContainText('2 of');
  await page.getByLabel('Default display currency').selectOption(initial.defaultCurrency);
  await page.getByRole('radio', { name: 'Others' }).check();
  await page.getByLabel('Optional clarification').fill('Community market');
  const readiness = await page.evaluate(() => ({
    followedCount: document.querySelector('.onboardingFollowCount strong')?.textContent,
    currency: (document.querySelector('.onboardingCurrencySelect select') as HTMLSelectElement | null)?.value,
    selectedReferral: (document.querySelector('input[name="referralSource"]:checked') as HTMLInputElement | null)?.value,
    submitDisabled: (document.querySelector('.onboardingComplete') as HTMLButtonElement | null)?.disabled
  }));
  await expect(page.getByRole('button', { name: 'Complete onboarding & continue' }), JSON.stringify(readiness)).toBeEnabled();

  await page.getByRole('button', { name: 'Complete onboarding & continue' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Good to see you, New' })).toBeVisible();
  const savedUser = await prisma.user.findUniqueOrThrow({ where: { email }, select: { onboardingCompletedAt: true, referralSource: true, referralOther: true, preference: { select: { displayCurrency: true, personalizationEnabled: true } } } });
  expect(savedUser.onboardingCompletedAt).toBeTruthy();
  expect(savedUser.referralSource).toBe('OTHER');
  expect(savedUser.referralOther).toBe('Community market');
  expect(savedUser.preference?.displayCurrency).toBe(initial.defaultCurrency);
  expect(savedUser.preference?.personalizationEnabled).toBe(false);
  expect(await prisma.storeFollow.count({ where: { user: { email } } })).toBeGreaterThanOrEqual(2);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Good to see you, New' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));

  await page.getByRole('button', { name: /New Onboarding Member, account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const login = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.goto('/onboarding');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Good to see you, New' })).toBeVisible();
});

test('official platform store is always recommended first and can count without approved in-stock products', async ({ page }) => {
  const officialStore = await prisma.store.findFirstOrThrow({ where: { isPlatformStore: true }, select: { id: true, sellerId: true } });
  const approvedInStockProducts = await prisma.product.count({ where: { sellerId: officialStore.sellerId, status: ProductStatus.APPROVED, inventory: { quantity: { gt: 0 } } } });
  expect(approvedInStockProducts).toBe(0);

  const { userId } = await registerApiAccount(page, 'onboarding-official');
  const headers = await csrfHeaders(page);
  const response = await page.request.get('/api/onboarding');
  expect(response.ok(), await response.text()).toBeTruthy();
  const state = await response.json() as { stores: { id: string; isOfficial: boolean }[]; defaultCurrency: string };
  expect(state.stores[0]).toMatchObject({ id: officialStore.id, isOfficial: true });

  const otherStore = state.stores.find(store => store.id !== officialStore.id);
  expect(otherStore).toBeTruthy();
  for (const storeId of [officialStore.id, otherStore!.id]) {
    const followed = await page.request.post(`/api/onboarding/stores/${storeId}/follow`, { data: {}, headers });
    expect(followed.ok(), await followed.text()).toBeTruthy();
  }

  const completion = await page.request.post('/api/onboarding/complete', { data: { displayCurrency: state.defaultCurrency, referralSource: 'GOOGLE' }, headers });
  expect(completion.ok(), await completion.text()).toBeTruthy();
  expect(await prisma.storeFollow.count({ where: { userId, storeId: officialStore.id } })).toBe(1);
});

test('API enforces eligible distinct follows, attribution validation, and server-side onboarding gates', async ({ page }) => {
  const { email, userId } = await registerApiAccount(page, 'onboarding-api');
  let headers = await csrfHeaders(page);
  const onboardingResponse = await page.request.get('/api/onboarding');
  const onboarding = await onboardingResponse.json() as { stores: { id: string }[]; defaultCurrency: string };
  const eligibleIds = onboarding.stores.slice(0, 2).map(store => store.id);
  expect(eligibleIds).toHaveLength(2);

  const hiddenStore = createdStores[2]!;
  const rejected = await page.request.post(`/api/onboarding/stores/${hiddenStore}/follow`, { data: {}, headers });
  expect(rejected.status()).toBe(404);
  const forged = await page.request.post(`/api/onboarding/stores/${eligibleIds[0]}/follow`, { data: { userId: 'another-user' }, headers });
  expect(forged.status()).toBe(400);
  const protectedCart = await page.request.get('/api/cart');
  expect(protectedCart.status()).toBe(428);
  expect((await protectedCart.json()).code).toBe('ONBOARDING_REQUIRED');

  const logout = await page.request.post('/api/auth/logout', { headers });
  expect(logout.status()).toBe(204);
  await page.goto('/?auth=login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: /Welcome to/ })).toBeVisible({ timeout: 15_000 });
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);
  headers = await csrfHeaders(page);

  const firstFollow = await page.request.post(`/api/onboarding/stores/${eligibleIds[0]}/follow`, { data: {}, headers });
  expect(firstFollow.ok(), await firstFollow.text()).toBeTruthy();
  const repeatedFollow = await page.request.post(`/api/onboarding/stores/${eligibleIds[0]}/follow`, { data: {}, headers });
  expect(repeatedFollow.ok(), await repeatedFollow.text()).toBeTruthy();
  expect(await prisma.storeFollow.count({ where: { userId, storeId: eligibleIds[0] } })).toBe(1);

  const incomplete = await page.request.post('/api/onboarding/complete', { data: { displayCurrency: onboarding.defaultCurrency, referralSource: 'GOOGLE' }, headers });
  expect(incomplete.status()).toBe(409);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboardingCompletedAt: true } })).onboardingCompletedAt).toBeNull();
  const invalidSource = await page.request.post('/api/onboarding/complete', { data: { displayCurrency: onboarding.defaultCurrency, referralSource: 'OTHER<script>' }, headers });
  expect(invalidSource.status()).toBe(400);

  const secondFollow = await page.request.post(`/api/onboarding/stores/${eligibleIds[1]}/follow`, { data: {}, headers });
  expect(secondFollow.ok(), await secondFollow.text()).toBeTruthy();
  const completion = { displayCurrency: onboarding.defaultCurrency, referralSource: 'GOOGLE' };
  const concurrentCompletions = await Promise.all([
    page.request.post('/api/onboarding/complete', { data: completion, headers }),
    page.request.post('/api/onboarding/complete', { data: completion, headers })
  ]);
  expect(concurrentCompletions.map(response => response.status()), await Promise.all(concurrentCompletions.map(response => response.text()))).toEqual([200, 200]);
  const retry = await page.request.post('/api/onboarding/complete', { data: { ...completion, referralSource: 'FACEBOOK' }, headers });
  expect(retry.ok(), await retry.text()).toBeTruthy();
  expect(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralSource: true } })).toMatchObject({ referralSource: 'GOOGLE' });
});

test('currency deactivated during onboarding is rejected, and admins can inspect readiness', async ({ page, browser }) => {
  const publicSettingsResponse = await page.request.get('/api/settings/public');
  expect(publicSettingsResponse.ok(), await publicSettingsResponse.text()).toBeTruthy();
  const baseCurrency = (await publicSettingsResponse.json() as { baseCurrency: string }).baseCurrency;
  const currencies = await prisma.currencyCatalogEntry.findMany({ select: { code: true } });
  const knownCodes = new Set(currencies.map(item => item.code));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let syntheticCode = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = `T${alphabet[Math.floor(Math.random() * alphabet.length)]}${alphabet[Math.floor(Math.random() * alphabet.length)]}`;
    if (!knownCodes.has(candidate)) { syntheticCode = candidate; break; }
  }
  expect(syntheticCode).toBeTruthy();
  await prisma.currencyCatalogEntry.create({ data: { code: syntheticCode, name: 'Synthetic Onboarding Currency', symbol: 'T', minorUnitExponent: 2, region: 'TEST', active: true, displayEnabled: true } });
  await prisma.exchangeRateSnapshot.create({ data: { baseCurrency, quoteCurrency: syntheticCode, rate: '1.25', provider: `onboarding-e2e-${randomUUID().slice(0, 8)}`, sourceDate: new Date(new Date().toISOString().slice(0, 10)), fetchedAt: new Date() } });
  try {
    const { userId } = await registerApiAccount(page, 'onboarding-currency');
    const headers = await csrfHeaders(page);
    const state = await (await page.request.get('/api/onboarding')).json() as { stores: { id: string }[]; currencies: { code: string }[] };
    expect(state.currencies.some(currency => currency.code === syntheticCode)).toBe(true);
    for (const store of state.stores.slice(0, 2)) {
      const followed = await page.request.post(`/api/onboarding/stores/${store.id}/follow`, { data: {}, headers });
      expect(followed.ok(), await followed.text()).toBeTruthy();
    }
    await prisma.currencyCatalogEntry.update({ where: { code: syntheticCode }, data: { active: false } });
    const staleChoice = await page.request.post('/api/onboarding/complete', { data: { displayCurrency: syntheticCode, referralSource: 'OTHER', referralOther: 'Temporary event' }, headers });
    expect(staleChoice.status()).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboardingCompletedAt: true } })).onboardingCompletedAt).toBeNull();
  } finally {
    await prisma.exchangeRateSnapshot.deleteMany({ where: { quoteCurrency: syntheticCode } });
    await prisma.currencyCatalogEntry.deleteMany({ where: { code: syntheticCode } });
  }

  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    const login = await adminPage.request.post('/api/auth/login', { data: { email: 'admin.local@example.test', password: demoPassword } });
    expect(login.ok(), await login.text()).toBeTruthy();
    const readiness = await adminPage.request.get('/api/admin/onboarding/readiness');
    expect(readiness.ok(), await readiness.text()).toBeTruthy();
    expect(await readiness.json()).toMatchObject({ minimumStores: 2, ready: true });
  } finally { await adminContext.close(); }
});
