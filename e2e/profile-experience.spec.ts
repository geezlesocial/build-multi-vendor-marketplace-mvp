import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required for profile browser tests.');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const password = 'Profile-E2E-Only-Password-42!';
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAABJRU5ErkJggg==', 'base64');
const invalidSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__unsafe=true</script></svg>');
function uniqueEmail(label: string) { return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`; }
test.afterAll(async () => { await prisma.$disconnect(); });

async function login(page: Page, email: string, localPassword = 'LocalDemoOnly-ChangeMe-123!') {
  const response = await page.request.post('/api/auth/login', { data: { email, password: localPassword } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function register(page: Page, name = 'Avatar Test Member') {
  const email = uniqueEmail('profile');
  const response = await page.request.post('/api/auth/register', { data: { email, name, password } });
  expect(response.status(), await response.text()).toBe(201);
  const user = (await response.json()).user as { id: string; name: string };
  await prisma.user.update({ where: { id: user.id }, data: { onboardingCompletedAt: new Date() } });
  return { email, user };
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

async function uploadAvatar(page: Page) {
  await page.goto('/settings#profile');
  await page.locator('input[type="file"]').setInputFiles({ name: 'profile.png', mimeType: 'image/png', buffer: validPng });
  const response = page.waitForResponse(item => item.url().endsWith('/api/account/avatar/uploads') && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Upload photo' }).click();
  const result = await response;
  const body = await result.json();
  expect(result.status(), JSON.stringify(body)).toBe(503);
  expect(body.error).toContain('Managed private media storage is unavailable');
  return 'UNAVAILABLE' as const;
}

test('guest sees guest navigation only after the session check, and sign-in fields are empty', async ({ page }) => {
  let releaseSessionCheck!: () => void;
  let signalSessionCheck!: () => void;
  const sessionCheckStarted = new Promise<void>(resolve => { signalSessionCheck = resolve; });
  const sessionGate = new Promise<void>(resolve => { releaseSessionCheck = resolve; });
  await page.route('**/api/auth/me', async route => { signalSessionCheck(); await sessionGate; await route.continue(); });
  const navigation = page.goto('/');
  await sessionCheckStarted;
  await expect(page.getByRole('heading', { name: 'Preparing your marketplace' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account', exact: true })).toHaveCount(0);
  releaseSessionCheck();
  await navigation;
  await expect(page.getByRole('heading', { name: 'A more thoughtful way to shop independent stores.' })).toBeVisible();
  const mainNav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(mainNav.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(mainNav.getByRole('link', { name: 'Create account' })).toBeVisible();
  await page.goto('/?auth=login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Password', exact: true })).toHaveValue('');
});

test('buyer homepage and account menu are distinct, role-limited, keyboard and outside-click accessible', async ({ page }) => {
  await login(page, 'buyer.local@example.test');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Good to see you, Local.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your account at a glance' })).toBeVisible();
  await expect(page.getByText('Welcome back', { exact: false })).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Local Buyer, account menu' });
  await expect(trigger.locator('.avatarFallback')).toHaveText('LB');
  await trigger.click();
  const menu = page.locator('#account-menu');
  await expect(menu.getByRole('link', { name: 'Buyer dashboard' })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Seller dashboard' })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'Admin dashboard' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await trigger.click();
  await page.getByRole('heading', { name: 'Good to see you, Local.' }).click();
  await expect(menu).toBeHidden();
  await trigger.click();
  await menu.getByRole('link', { name: 'Orders' }).click();
  await expect(page).toHaveURL(/\/dashboard\?tab=orders/);
  await expect(menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Local Buyer, account menu' }).click();
  await page.locator('#account-menu').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
});

test('repeated guest and member navigation keeps session inspection available', async ({ page }) => {
  const sessionStatuses: number[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/auth/me') sessionStatuses.push(response.status());
  });

  for (let navigation = 0; navigation < 5; navigation += 1) {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'A more thoughtful way to shop independent stores.' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  }
  await login(page, 'buyer.local@example.test');

  // Full navigation re-mounts the StrictMode session provider; dashboard
  // pages also load their own access identity. The focused middleware test
  // separately exercises more than 60 session reads without overloading the
  // app's shared 300-per-minute API safety limit.
  for (let navigation = 0; navigation < 4; navigation += 1) {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Good to see you, Local.' })).toBeVisible();
    await page.goto('/dashboard?tab=orders');
    await expect(page.getByRole('heading', { name: 'Buyer dashboard' })).toBeVisible();
  }

  expect(sessionStatuses.length).toBeGreaterThanOrEqual(17);
  expect(sessionStatuses.filter(status => status === 429)).toEqual([]);
  expect(sessionStatuses.every(status => status === 200)).toBe(true);
});

test('seller dashboard entry is role-aware and admin dashboard stays separate', async ({ page, browser }) => {
  await login(page, 'seller.local@example.test');
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Seller, account menu' }).click();
  const menu = page.locator('#account-menu');
  await expect(menu.getByRole('link', { name: 'Buyer dashboard' })).toHaveAttribute('href', '/dashboard?mode=buyer');
  await expect(menu.getByRole('link', { name: 'Seller dashboard' })).toHaveAttribute('href', '/dashboard?mode=seller');
  await expect(menu.getByRole('link', { name: 'Admin dashboard' })).toHaveCount(0);
  await menu.getByRole('link', { name: 'Seller dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Seller dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buyer view' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Seller view' })).toHaveAttribute('aria-pressed', 'true');

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await login(adminPage, 'admin.local@example.test');
  await adminPage.goto('/');
  await adminPage.getByRole('button', { name: 'Local Admin, account menu' }).click();
  const adminMenu = adminPage.locator('#account-menu');
  await expect(adminMenu.getByRole('link', { name: 'Admin dashboard' })).toBeVisible();
  await expect(adminMenu.getByRole('link', { name: 'Buyer dashboard' })).toHaveCount(0);
  await expect(adminMenu.getByRole('link', { name: 'Seller dashboard' })).toHaveCount(0);
  await adminContext.close();
});

test('profile name persists and unavailable managed avatar storage preserves the fallback', async ({ page }) => {
  const { email } = await register(page);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Avatar Test Member, account menu' });
  await expect(trigger.locator('.avatarFallback')).toHaveText('AT');
  await page.goto('/settings#profile');
  await page.getByLabel('Display name').fill('Avery Member');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('button', { name: 'Avery Member, account menu' })).toBeVisible();
  await uploadAvatar(page);
  await expect(page.getByRole('alert')).toContainText('Managed private media storage is unavailable');
  await expect(page.locator('.accountTrigger img.avatarImage')).toHaveCount(0);
  await expect(page.locator('.accountTrigger .avatarFallback')).toHaveText('AM');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Avery Member, account menu' })).toBeVisible();
  await expect(page.locator('.accountTrigger .avatarFallback')).toHaveText('AM');
  expect((await page.request.get('/api/account/avatar')).status()).toBe(404);
  expect((await page.request.get('/api/auth/me')).ok()).toBe(true);
  expect(((await (await page.request.get('/api/auth/me')).json()).user).name).toBe('Avery Member');
  expect(email).toContain('@example.test');
});

test('avatar upload clearly reports that managed storage is unavailable without claiming success', async ({ page }) => {
  await register(page, 'Storage Unavailable Member');
  await page.goto('/settings#profile');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'pending-profile.png', mimeType: 'image/png', buffer: validPng });
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/account/avatar/uploads') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Upload photo' }).click();
  const response = await uploadResponse;
  expect(response.status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText('Managed private media storage is unavailable');
  await expect(page.locator('.profileAvatar img')).toHaveCount(0);
  await expect(page.locator('.accountTrigger .avatarFallback')).toHaveText('SU');
  expect((await page.request.get('/api/account/avatar')).status()).toBe(404);
  await page.reload();
  await expect(page.locator('.profileAvatar img')).toHaveCount(0);
  expect((await page.request.get('/api/account/avatar')).status()).toBe(404);
});

test('invalid and unauthorized profile photo uploads are rejected without changing the saved photo', async ({ page, browser }) => {
  const { user } = await register(page, 'Private Avatar Owner');
  await uploadAvatar(page);
  const before = await page.request.get('/api/account/avatar');
  expect(before.status()).toBe(404);
  const invalid = await page.request.post('/api/account/avatar/uploads', { data: { fileName: 'unsafe.svg', contentType: 'image/svg+xml', sizeBytes: invalidSvg.length }, headers: await csrfHeaders(page) });
  expect(invalid.status()).toBe(415);
  const oversized = await page.request.post('/api/account/avatar/uploads', { data: { fileName: 'large.png', contentType: 'image/png', sizeBytes: 5_000_001 }, headers: await csrfHeaders(page) });
  expect(oversized.status()).toBe(413);
  const after = await page.request.get('/api/account/avatar');
  expect(after.status()).toBe(before.status());
  expect((await page.request.get('/content-media/not-a-public-avatar')).status()).toBe(404);

  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await register(strangerPage, 'Different Member');
  const privateAvatar = await strangerPage.request.get(`/api/account/avatar?userId=${encodeURIComponent(user.id)}`);
  expect(privateAvatar.status()).toBe(404);
  await strangerContext.close();

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  expect((await guestPage.request.get('/api/account/avatar')).status()).toBe(401);
  expect((await guestPage.request.post('/api/account/avatar/uploads', { data: { fileName: 'profile.png', contentType: 'image/png', sizeBytes: validPng.length } })).status()).toBe(403);
  await guestContext.close();
});

test('mobile account navigation remains usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'buyer.local@example.test');
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Buyer, account menu' }).click();
  const menu = page.locator('#account-menu');
  await expect(menu.getByRole('link', { name: 'Profile and settings' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
