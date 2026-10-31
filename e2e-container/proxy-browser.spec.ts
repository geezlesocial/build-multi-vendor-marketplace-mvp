import { expect, test } from '@playwright/test';

const expectedOrigin = new URL(process.env.STAGING_SMOKE_BASE_URL ?? 'http://127.0.0.1:5174').origin;

test('production web container serves SPA assets and keeps API routes on the proxy', async ({ page, request }) => {
  const staticResponses: Array<{ type: string; status: number }> = [];
  page.on('response', response => {
    const resourceType = response.request().resourceType();
    if (['script', 'stylesheet'].includes(resourceType) && new URL(response.url()).origin === expectedOrigin) {
      staticResponses.push({ type: resourceType, status: response.status() });
    }
  });

  const navigation = await page.goto('/dashboard?mode=buyer&tab=overview', { waitUntil: 'domcontentloaded' });
  expect(navigation?.status()).toBe(200);
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.locator('#root')).toContainText('Shop');
  expect(staticResponses.some(response => response.type === 'script' && response.status === 200), 'application JavaScript must load from the web image').toBeTruthy();
  expect(staticResponses.some(response => response.type === 'stylesheet' && response.status === 200), 'application CSS must load from the web image').toBeTruthy();

  const apiResponse = await request.get('/api/auth/me');
  expect(apiResponse.status()).toBe(200);
  expect(apiResponse.headers()['content-type']).toMatch(/application\/json/i);
  expect((await apiResponse.json()).user).toBeNull();

  const unknownApi = await request.get('/api/__container_smoke_not_found__');
  expect(unknownApi.status()).toBe(404);
  expect(unknownApi.headers()['content-type']).toMatch(/application\/json/i);
  expect(await unknownApi.text()).not.toContain('<div id="root">');
});
