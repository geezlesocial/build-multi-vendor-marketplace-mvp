import { expect, test, type Locator, type Page } from '@playwright/test';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const demoPassword = 'LocalDemoOnly-ChangeMe-123!';
const adminEmail = 'admin.local@example.test';
const sellerEmail = 'seller.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const editorEmail = 'editor.local@example.test';
const isolatedSellerPassword = 'PlanIsolation-Test-Only-Password-2026!';
const testPasswordPepper = process.env.PASSWORD_PEPPER;
if (!testPasswordPepper) throw new Error('PASSWORD_PEPPER is required for isolated E2E account fixtures.');
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
if (!e2eDatabaseUrl) throw new Error('E2E_DATABASE_URL is required; this suite must use the isolated E2E database.');
const parsedDatabaseUrl = new URL(e2eDatabaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsedDatabaseUrl.hostname) || !/(e2e|test)/i.test(parsedDatabaseUrl.pathname)) {
  throw new Error('Store plan tests require a loopback-only disposable test/e2e database.');
}

const prisma = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl } } });
const otherSellerEmail = `plan-isolation-${randomUUID().slice(0, 8)}@example.test`;
let otherStoreId = '';

async function signIn(page: Page, email: string, password = demoPassword) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const token = cookies.find(cookie => cookie.name === 'marketplace_csrf')?.value;
  return token ? { 'x-csrf-token': token } : {};
}

async function newPlan(page: Page, key: string, overrides: Partial<Record<string, unknown>> = {}) {
  const entitlements = {
    productLimit: 25,
    storeLimit: 1,
    vendorLimit: 1,
    staffSeatLimit: 3,
    allowedThemes: ['CLASSIC', 'EDITORIAL'],
    customDomainEligible: false,
    paymentConnectors: [],
    mobileTemplates: ['RESPONSIVE_STANDARD'],
    ...overrides
  };
  const response = await page.request.post('/api/admin/store-plans', {
    data: { key, name: `Plan ${key}`, entitlements, reason: 'Disposable store plan E2E verification' },
    headers: await csrfHeaders(page)
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{ plan: { id: string }; version: { id: string; version: number } }>;
}

async function activatePlan(page: Page, planId: string, versionId: string) {
  const response = await page.request.post(`/api/admin/store-plans/${planId}/activate`, {
    data: { versionId, reason: 'Activate disposable plan E2E version' },
    headers: await csrfHeaders(page)
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function activatePlanFromAdminUI(page: Page, planCard: Locator, plan: { id: string; name: string }, version: { id: string; version: number }) {
  const dialogPromise = page.waitForEvent('dialog');
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/admin/store-plans/${plan.id}/activate` && response.request().method() === 'POST'
  );
  const clickPromise = planCard.getByRole('button', { name: 'Activate version' }).click();

  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toBe(`Activate ${plan.name} version ${version.version} for new Store subscriptions and assignments? Existing subscriptions keep their saved price and terms. Activation does not charge anyone.`);
  await dialog.accept();
  await clickPromise;

  const response = await responsePromise;
  const responseBody = await response.json() as {
    plan: { id: string; status: string };
    version: { id: string; version: number; status: string };
    alreadyActive: boolean;
  };
  expect(response.status(), JSON.stringify(responseBody)).toBe(200);
  expect(responseBody).toMatchObject({
    plan: { id: plan.id, status: 'ACTIVE' },
    version: { id: version.id, version: version.version, status: 'ACTIVE' },
    alreadyActive: false
  });

  const versionRow = planCard.locator('.storePlanVersion').filter({ hasText: `Version ${version.version} ·` });
  await expect(versionRow).toContainText('ACTIVE');
}

async function assignPlan(page: Page, storeId: string, versionId: string) {
  const response = await page.request.post(`/api/admin/store-plan-stores/${storeId}/assignments`, {
    data: { versionId, reason: 'Assign disposable plan E2E version' },
    headers: await csrfHeaders(page)
  });
  expect([200, 201], await response.text()).toContain(response.status());
  return response.json();
}

async function getSellerStore(page: Page) {
  const response = await page.request.get('/api/admin/store-plan-stores');
  expect(response.ok(), await response.text()).toBeTruthy();
  const stores = await response.json() as { id: string; name: string; seller: { user: { email: string } } }[];
  const store = stores.find(item => item.seller.user.email === sellerEmail);
  expect(store, `Expected a Store owned by ${sellerEmail}`).toBeTruthy();
  return store!;
}

async function seedOtherStore() {
  const passwordHash = await bcrypt.hash(`${isolatedSellerPassword}${testPasswordPepper}`, 4);
  const user = await prisma.user.create({
    data: {
      email: otherSellerEmail,
      name: 'Isolated Plan Seller',
      role: Role.SELLER,
      passwordHash,
      seller: { create: { status: SellerStatus.APPROVED, store: { create: { name: 'Isolated Plan Store', slug: `isolated-plan-${randomUUID().slice(0, 8)}` } } } }
    },
    include: { seller: { include: { store: true } } }
  });
  if (!user.seller?.store) throw new Error('Disposable second Store fixture was not created.');
  otherStoreId = user.seller.store.id;
}

test.beforeAll(async () => { await seedOtherStore(); });
test.afterAll(async () => { await prisma.$disconnect(); });

test('fresh migration and seed preserve legacy-compatible entitlements for existing demo Stores', async ({ page }) => {
  await signIn(page, sellerEmail);
  const response = await page.request.get('/api/seller/plan');
  expect(response.ok(), await response.text()).toBeTruthy();
  const plan = await response.json();
  expect(plan.plan).toMatchObject({ key: 'legacy-compatible', status: 'ACTIVE', version: 1 });
  expect(plan.assignment).toMatchObject({ source: 'LEGACY_BOOTSTRAP', status: 'ACTIVE' });
  expect(plan.entitlements.productLimit).toBeGreaterThan(1_000_000);
  expect(plan.entitlements.staffSeatLimit).toBeGreaterThan(1_000_000);
  expect(plan.entitlements.allowedThemes).toEqual(expect.arrayContaining(['CLASSIC', 'EDITORIAL', 'BOUTIQUE']));
});

test('admin creates, versions, activates, assigns, and retires a plan without removing current access', async ({ page, browser }) => {
  await signIn(page, adminEmail);
  await page.goto('/admin/platform');
  await page.getByRole('button', { name: 'Store plans' }).click();
  await expect(page.getByRole('heading', { name: 'Store plans and versions' })).toBeVisible();

  const key = `starter-${randomUUID().slice(0, 6)}`;
  await page.getByLabel('Plan name').fill('Starter Store Plan');
  await page.getByLabel('Plan key').fill(key);
  await page.getByLabel('Product limit').fill('2');
  await page.getByLabel('Store limit').fill('1');
  await page.getByLabel('Vendor limit').fill('1');
  await page.getByLabel('Staff-seat limit').fill('2');
  await page.getByLabel('Reason for change').fill('Create and activate plan for local acceptance coverage');
  const createResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/store-plans' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create draft plan' }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  await expect(page.getByRole('status').filter({ hasText: 'Plan saved as a draft version.' })).toBeVisible();

  const planList = await page.request.get('/api/admin/store-plans');
  const plans = await planList.json() as { id: string; key: string; versions: { id: string; version: number; status: string }[] }[];
  const plan = plans.find(item => item.key === key);
  expect(plan).toBeTruthy();
  const firstVersion = plan!.versions.find(version => version.status === 'DRAFT')!;
  const planCard = page.locator('.storePlanAdminCard').filter({ hasText: key });
  await expect(planCard).toBeVisible();
  await activatePlanFromAdminUI(page, planCard, { id: plan!.id, name: 'Starter Store Plan' }, firstVersion);
  await expect(planCard).toContainText('ACTIVE');

  await page.reload();
  await page.getByRole('button', { name: 'Store plans' }).click();
  await expect(page.getByRole('heading', { name: 'Store plans and versions' })).toBeVisible();
  const reloadedPlansResponse = await page.request.get('/api/admin/store-plans');
  expect(reloadedPlansResponse.ok(), await reloadedPlansResponse.text()).toBeTruthy();
  const reloadedPlans = await reloadedPlansResponse.json() as { id: string; key: string; status: string; versions: { id: string; version: number; status: string }[] }[];
  const reloadedPlan = reloadedPlans.find(item => item.id === plan!.id)!;
  expect(reloadedPlan.status).toBe('ACTIVE');
  expect(reloadedPlan.versions.find(version => version.id === firstVersion.id)?.status).toBe('ACTIVE');
  await expect(page.locator('.storePlanAdminCard').filter({ hasText: key }).locator('.storePlanVersion').filter({ hasText: 'Version 1 ·' })).toContainText('ACTIVE');

  const demoStore = await getSellerStore(page);
  const activePlansResponse = await page.request.get('/api/admin/store-plans');
  const activePlans = await activePlansResponse.json() as { id: string; key: string; versions: { id: string; version: number; status: string }[] }[];
  const activePlan = activePlans.find(item => item.key === key)!;
  const activeVersion = activePlan.versions.find(version => version.status === 'ACTIVE')!;
  const assignmentSelects = page.locator('.storeAssignmentPanel select');
  await expect(assignmentSelects).toHaveCount(2);
  await assignmentSelects.nth(0).selectOption(demoStore!.id);
  await assignmentSelects.nth(1).selectOption(activeVersion.id);
  await page.getByLabel('Reason', { exact: true }).fill('Assign starter plan to demo Store');
  await page.getByRole('button', { name: 'Assign plan' }).click();
  await expect(page.getByText('Plan assignment saved and audited.')).toBeVisible();
  await expect(page.locator('.storeAssignmentRow').filter({ hasText: 'Starter Store Plan' })).toBeVisible();

  await planCard.getByRole('button', { name: 'Edit / new version' }).click();
  await page.getByLabel('Product limit').fill('4');
  await page.getByLabel('Reason for change').fill('Create version two without rewriting the assigned version');
  const editResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/store-plans/${plan!.id}` && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save new draft version' }).click();
  const editResponse = await editResponsePromise;
  expect(editResponse.status(), await editResponse.text()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Plan saved as a draft version.' })).toBeVisible();
  const afterEdit = await page.request.get('/api/admin/store-plans');
  const versions = (await afterEdit.json() as { key: string; versions: { id: string; version: number; status: string }[] }[]).find(item => item.key === key)!.versions;
  const versionTwo = versions.find(version => version.version === 2)!;
  expect(versionTwo.status).toBe('DRAFT');
  await activatePlanFromAdminUI(page, planCard, { id: plan!.id, name: 'Starter Store Plan' }, versionTwo);
  await page.getByLabel('Active plan version').selectOption(versionTwo.id);
  await page.getByLabel('Reason', { exact: true }).fill('Move demo Store to the newly activated version');
  await page.getByRole('button', { name: 'Assign plan' }).click();
  await expect(page.getByText('Plan assignment saved and audited.')).toBeVisible();

  page.on('dialog', dialog => dialog.accept());
  await planCard.getByRole('button', { name: 'Retire plan' }).click();
  await expect(page.getByText('Starter Store Plan retired. Existing Store assignments remain in effect.')).toBeVisible();
  const historyResponse = await page.request.get(`/api/admin/store-plan-stores/${demoStore!.id}/assignments`);
  const history = await historyResponse.json() as { assignedById?: string; assignedBy: { email: string } | null; status: string; planVersion: { plan: { key: string } } }[];
  expect(history[0].status).toBe('ACTIVE');
  expect(history[0].planVersion.plan.key).toBe(key);
  expect(history[0].planVersion.version).toBe(2);
  expect(history[1].status).toBe('SUPERSEDED');
  expect(history[0].assignedBy?.email).toBe(adminEmail);
  const auditResponse = await page.request.get('/api/admin/audit');
  const auditRows = await auditResponse.json() as { action: string; entityId: string }[];
  expect(auditRows.some(row => row.action === 'STORE_PLAN_ASSIGNED' && row.entityId === demoStore!.id)).toBe(true);
  const retiredAssignment = await page.request.post(`/api/admin/store-plan-stores/${otherStoreId}/assignments`, { data: { versionId: activeVersion.id, reason: 'Must reject assignment to retired plan' }, headers: await csrfHeaders(page) });
  expect(retiredAssignment.status()).toBe(409);

  const sellerContext = await browser.newContext();
  try {
    const sellerPage = await sellerContext.newPage();
    await signIn(sellerPage, sellerEmail);
    const sellerPlan = await sellerPage.request.get('/api/seller/plan');
    expect(sellerPlan.ok()).toBeTruthy();
    const sellerPlanBody = await sellerPlan.json();
    expect(sellerPlanBody.plan.key).toBe(key);
    expect(sellerPlanBody.plan.status).toBe('RETIRED');
  } finally { await sellerContext.close(); }
});

test('product quotas, theme entitlements, and staff-seat limits are enforced at the exact boundary', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const sellerContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, adminEmail);
    const demoStore = await getSellerStore(adminPage);
    const created = await newPlan(adminPage, `quota-${randomUUID().slice(0, 6)}`, { productLimit: 2, staffSeatLimit: 0, allowedThemes: ['CLASSIC'] });
    await activatePlan(adminPage, created.plan.id, created.version.id);
    await assignPlan(adminPage, demoStore.id, created.version.id);

    const sellerPage = await sellerContext.newPage();
    await signIn(sellerPage, sellerEmail);
    await sellerPage.goto('/seller/plan');
    await expect(sellerPage.getByRole('heading', { name: 'Plan & Billing' })).toBeVisible();
    await expect(sellerPage.getByText('1 of 2 used')).toBeVisible();
    await expect(sellerPage.getByText('0 of 0 used')).toBeVisible();

    const csrf = await csrfHeaders(sellerPage);
    const productInput = { name: 'Plan boundary item', description: 'Disposable plan quota boundary fixture.', priceMinor: 1200, stock: 2 };
    const allowed = await sellerPage.request.post('/api/products', { data: productInput, headers: csrf });
    expect(allowed.status(), await allowed.text()).toBe(201);
    const denied = await sellerPage.request.post('/api/products', { data: { ...productInput, name: 'Over quota item' }, headers: csrf });
    expect(denied.status()).toBe(409);
    const limit = await denied.json();
    expect(limit).toMatchObject({ code: 'PLAN_LIMIT_REACHED', entitlement: 'productLimit', usage: 2, limit: 2, upgradeRequired: true });

    const theme = await sellerPage.request.get('/api/seller/store-theme');
    const themeBody = await theme.json();
    const deniedTheme = await sellerPage.request.put('/api/seller/store-theme', { data: { ...themeBody.draft, name: themeBody.name, themePreset: 'EDITORIAL' }, headers: csrf });
    expect(deniedTheme.status()).toBe(409);
    expect(await deniedTheme.json()).toMatchObject({ code: 'PLAN_ENTITLEMENT_REQUIRED', entitlement: 'themePreset', upgradeRequired: true });

    const seller = await prisma.seller.findFirst({ where: { user: { email: sellerEmail } } });
    const staffUser = await prisma.user.create({ data: { email: `seat-limit-${randomUUID().slice(0, 8)}@example.test`, name: 'Disposable Seat User', role: Role.BUYER, passwordHash: 'unused-test-only-hash' } });
    await expect(prisma.sellerStaff.create({ data: { sellerId: seller!.id, userId: staffUser.id } })).rejects.toThrow(/staff seat limit/i);
  } finally {
    await sellerContext.close();
    await adminContext.close();
  }
});

test('admin permissions and seller plan reads remain scoped to each Store owner', async ({ browser }) => {
  const guestContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const sellerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    expect((await guest.request.get('/api/admin/store-plans')).status()).toBe(401);

    const adminPage = await adminContext.newPage();
    await signIn(adminPage, adminEmail);
    const demoStore = await getSellerStore(adminPage);
    const keyA = `seller-a-${randomUUID().slice(0, 6)}`;
    const keyB = `seller-b-${randomUUID().slice(0, 6)}`;
    const a = await newPlan(adminPage, keyA, { productLimit: 12 });
    const b = await newPlan(adminPage, keyB, { productLimit: 77 });
    await activatePlan(adminPage, a.plan.id, a.version.id);
    await activatePlan(adminPage, b.plan.id, b.version.id);
    await assignPlan(adminPage, demoStore.id, a.version.id);
    await assignPlan(adminPage, otherStoreId, b.version.id);

    const buyerPage = await (await guestContext.newPage());
    await signIn(buyerPage, buyerEmail);
    expect((await buyerPage.request.get('/api/admin/store-plans')).status()).toBe(403);
    expect((await buyerPage.request.post('/api/admin/store-plans', { data: {}, headers: await csrfHeaders(buyerPage) })).status()).toBe(403);
    await signIn(buyerPage, editorEmail);
    expect((await buyerPage.request.get('/api/admin/store-plans')).status()).toBe(403);

    const sellerPage = await sellerContext.newPage();
    await signIn(sellerPage, sellerEmail);
    expect((await sellerPage.request.get('/api/admin/store-plan-stores')).status()).toBe(403);
    expect((await sellerPage.request.get(`/api/admin/store-plan-stores/${otherStoreId}/assignments`)).status()).toBe(403);
    const ownPlanResponse = await sellerPage.request.get(`/api/seller/plan?storeId=${encodeURIComponent(otherStoreId)}`);
    expect(ownPlanResponse.ok()).toBeTruthy();
    const ownPlan = await ownPlanResponse.json();
    expect(ownPlan.store.name).toBe(demoStore.name);
    expect(ownPlan.plan.key).toBe(keyA);

    const otherPage = await otherContext.newPage();
    await signIn(otherPage, otherSellerEmail, isolatedSellerPassword);
    const otherPlanResponse = await otherPage.request.get('/api/seller/plan');
    expect(otherPlanResponse.ok()).toBeTruthy();
    const otherPlan = await otherPlanResponse.json();
    expect(otherPlan.store.name).toBe('Isolated Plan Store');
    expect(otherPlan.plan.id).toBe(b.plan.id);
    expect(otherPlan.plan.key).toBe(keyB);
    expect(otherPlan.usage.vendors).toBe(1);
    expect(otherPlan.usage.staffSeats).toBe(0);
  } finally {
    await guestContext.close();
    await adminContext.close();
    await sellerContext.close();
    await otherContext.close();
  }
});
