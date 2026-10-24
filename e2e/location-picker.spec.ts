import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';
async function login(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: 'buyer.local@example.test', password } });
  expect(response.ok(), `Synthetic fixture login failed with ${response.status()}.`).toBeTruthy();
}
async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name === 'marketplace_csrf');
  expect(cookie?.value).toBeTruthy(); return { 'x-csrf-token': cookie!.value };
}

test('saved address map pin is opt-in, persists only after save, and external map traffic is blocked in test', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const label = `QA ${suffix}`;
  const tileRequests: string[] = [];
  await page.route('https://tile.openstreetmap.org/**', route => { tileRequests.push(route.request().url()); return route.abort(); });
  await login(page);
  await page.goto('/dashboard?mode=buyer');
  await page.getByRole('button', { name: 'Addresses' }).click();
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.getByLabel('Street address').fill('22 Example Road');
  await page.getByLabel('City', { exact: true }).fill('Example City');
  await page.getByLabel('Region', { exact: true }).fill('Example Region');
  await page.getByLabel('Postal code').fill('1000');
  await page.getByLabel('Country', { exact: true }).fill('US');
  await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear map pin' })).toBeDisabled();
  await page.locator('.addressMap').click({ position: { x: 170, y: 120 } });
  await expect(page.getByText(/Map point selected:/)).toBeVisible();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/account/addresses') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save address' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const saved = await response.json() as { id: string; label: string; latitude: number | null; longitude: number | null };
  expect(saved.label).toBe(label);
  expect(saved.latitude).toEqual(expect.any(Number));
  expect(saved.longitude).toEqual(expect.any(Number));
  const list = await page.request.get('/api/account/addresses');
  expect(list.ok()).toBeTruthy();
  const matching = (await list.json() as typeof saved[]).find(item => item.id === saved.id);
  expect(matching).toMatchObject({ latitude: saved.latitude, longitude: saved.longitude });
  const removed = await page.request.delete(`/api/account/addresses/${saved.id}`, { headers: await csrf(page) });
  expect(removed.status()).toBe(204);
  expect(tileRequests.length).toBeGreaterThan(0);
});

test('map picker stays usable on mobile with a manual-address fallback and no geolocation prompt until requested', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(window, '__geoRequests', { value: 0, writable: true });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success: (position: GeolocationPosition) => void) { (window as Window & { __geoRequests: number }).__geoRequests += 1; success({ coords: { latitude: 14.5995, longitude: 120.9842, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition); } } });
  });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await login(page);
  await page.goto('/dashboard?mode=buyer');
  await page.getByRole('button', { name: 'Addresses' }).click();
  await expect(page.getByLabel('Street address')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Attribution and tile-use policy' })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __geoRequests: number }).__geoRequests)).toBe(0);
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
  await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByText('Map point selected: 14.59950, 120.98420', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __geoRequests: number }).__geoRequests)).toBe(1);
});

test('map tile and denied-location errors preserve the manual address fallback', async ({ page }) => {
  const label = `Manual ${Date.now().toString(36)}`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(_success: PositionCallback, error: PositionErrorCallback) { error({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } } });
  });
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable in synthetic test' }));
  await login(page);
  await page.goto('/dashboard?mode=buyer');
  await page.getByRole('button', { name: 'Addresses' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Map tiles are temporarily unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Location was not shared' })).toBeVisible();
  await expect(page.getByLabel('Street address')).toBeEditable();
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.getByLabel('Street address').fill('9 Manual Fallback Road');
  await page.getByLabel('City', { exact: true }).fill('Example City');
  await page.getByLabel('Region', { exact: true }).fill('Example Region');
  await page.getByLabel('Postal code').fill('1000');
  await page.getByLabel('Country', { exact: true }).fill('US');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/account/addresses') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save address' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const saved = await response.json() as { id: string; label: string; latitude: number | null; longitude: number | null };
  expect(saved).toMatchObject({ label, latitude: null, longitude: null });
  const deleted = await page.request.delete(`/api/account/addresses/${saved.id}`, { headers: await csrf(page) });
  expect(deleted.status()).toBe(204);
});
