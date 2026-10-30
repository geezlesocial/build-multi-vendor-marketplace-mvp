import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './layout-assertions.js';

async function signInAsBuyer(page: Page) {
  const response = await page.request.post('/api/auth/login', {
    data: { email: 'buyer.local@example.test', password: 'LocalDemoOnly-ChangeMe-123!' }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test('settings cards and controls are balanced on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInAsBuyer(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  const pageContent = await page.locator('.settingsPage').boundingBox();
  const profile = await page.locator('#profile').boundingBox();
  expect(pageContent).not.toBeNull();
  expect(profile).not.toBeNull();
  expect(Math.abs(profile!.width - pageContent!.width)).toBeLessThanOrEqual(2);

  const cards = page.locator('.settingsGrid > .settingsCard');
  const cardHeadings = ['Language and currency', 'Security', 'Personalization', 'Notifications'];
  await expect(cards).toHaveCount(cardHeadings.length);
  for (const [index, heading] of cardHeadings.entries()) {
    await expect(cards.nth(index).getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  const preferencesCard = cards.filter({ has: page.getByRole('heading', { name: 'Language and currency', exact: true }) });
  const securityCard = cards.filter({ has: page.getByRole('heading', { name: 'Security', exact: true }) });
  const personalizationCard = cards.filter({ has: page.getByRole('heading', { name: 'Personalization', exact: true }) });
  const notificationsCard = cards.filter({ has: page.getByRole('heading', { name: 'Notifications', exact: true }) });
  const preferences = await preferencesCard.boundingBox();
  const security = await securityCard.boundingBox();
  const personalization = await personalizationCard.boundingBox();
  const notifications = await notificationsCard.boundingBox();
  expect(preferences).not.toBeNull();
  expect(security).not.toBeNull();
  expect(personalization).not.toBeNull();
  expect(notifications).not.toBeNull();
  expect(Math.abs(preferences!.y - security!.y)).toBeLessThanOrEqual(2);
  expect(preferences!.x + preferences!.width).toBeLessThanOrEqual(security!.x);
  expect(personalization!.y).toBeGreaterThan(preferences!.y);
  expect(Math.abs(personalization!.y - notifications!.y)).toBeLessThanOrEqual(2);
  expect(personalization!.x + personalization!.width).toBeLessThanOrEqual(notifications!.x);

  for (const label of ['Language', 'Default currency for estimates']) {
    const select = page.getByLabel(label);
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(180);
    expect(await select.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }

  for (const label of ['Current password', 'New password', 'Confirm new password']) {
    const field = page.getByLabel(label, { exact: true });
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(350);
  }
  const passwordButton = page.getByRole('button', { name: 'Change password' });
  const passwordButtonBox = await passwordButton.boundingBox();
  expect(passwordButtonBox).not.toBeNull();
  expect(passwordButtonBox!.width).toBeGreaterThanOrEqual(170);

  const toggle = notificationsCard.locator('.settingRow button').first();
  const toggleBox = await toggle.boundingBox();
  const notificationLink = page.getByRole('link', { name: 'Open buyer or seller dashboard' });
  const linkBox = await notificationLink.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(await notificationLink.evaluate(element => getComputedStyle(element).color)).toBe('rgb(49, 93, 71)');
  expect(toggleBox!.x).toBeGreaterThanOrEqual(notifications!.x);
});

test('settings sections stack without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsBuyer(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth }));
  await expectNoHorizontalOverflow(page);

  const cards = page.locator('.settingsGrid > .settingsCard');
  const cardHeadings = ['Language and currency', 'Security', 'Personalization', 'Notifications'];
  await expect(cards).toHaveCount(cardHeadings.length);
  for (const [index, heading] of cardHeadings.entries()) {
    await expect(cards.nth(index).getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  const boxes = await Promise.all(cardHeadings.map((_, index) => cards.nth(index).boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index]!.y).toBeGreaterThan(boxes[index - 1]!.y);
  }
  for (const box of boxes) {
    expect(Math.abs(box!.x - boxes[0]!.x)).toBeLessThanOrEqual(2);
    expect(box!.width).toBeLessThanOrEqual(dimensions.clientWidth - 32);
  }

  for (const label of ['Language', 'Default currency for estimates']) {
    const select = page.getByLabel(label);
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(250);
    expect(box!.x + box!.width).toBeLessThanOrEqual(dimensions.clientWidth - 8);
  }
});
