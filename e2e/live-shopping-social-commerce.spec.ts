import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import { expect, test } from '@playwright/test';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; live shopping tests must use the disposable E2E database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

test.afterAll(async () => prisma.$disconnect());

test('seller can create and update a six-item live shelf without erasing historic links or changing provider state', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'seller.local@example.test', password: 'LocalDemoOnly-ChangeMe-123!' }
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf');
  expect(csrf).toBeTruthy();
  const headers = { 'x-csrf-token': csrf!.value };
  const product = await prisma.product.findUnique({ where: { slug: 'demo-canvas-tote' }, select: { id: true } });
  expect(product).toBeTruthy();

  const createdResponse = await page.request.post('/api/seller/live-sessions', {
    headers,
    data: { title: 'Disposable live-commerce test', description: 'E2E only', timezone: 'Asia/Singapore', productIds: [product!.id], featuredProductId: product!.id }
  });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = await createdResponse.json() as { id: string; status: string; products: { productId: string; featured: boolean; shopFeatured: boolean; shopSortOrder: number; shopPinned: boolean }[] };
  expect(created.status).toBe('DRAFT');
  expect(created.products).toMatchObject([{ productId: product!.id, featured: true, shopFeatured: true, shopSortOrder: 0, shopPinned: true }]);

  const tooManyProducts = await page.request.patch(`/api/seller/live-sessions/${created.id}/products`, {
    headers,
    data: { productIds: Array.from({ length: 7 }, (_, index) => `c${String(index + 1).repeat(23)}`), featuredProductId: null }
  });
  expect(tooManyProducts.status()).toBe(400);

  const providerMutation = await page.request.patch(`/api/seller/live-sessions/${created.id}/products`, {
    headers,
    data: { productIds: [product!.id], featuredProductId: product!.id, status: 'LIVE', providerSessionRef: 'untrusted' }
  });
  expect(providerMutation.status()).toBe(400);

  const clearedResponse = await page.request.patch(`/api/seller/live-sessions/${created.id}/products`, {
    headers,
    data: { productIds: [], featuredProductId: null }
  });
  expect(clearedResponse.status(), await clearedResponse.text()).toBe(200);
  const cleared = await clearedResponse.json() as { status: string; providerSessionRef?: string | null; products: { productId: string; featured: boolean; shopFeatured: boolean; shopSortOrder: number | null; shopPinned: boolean }[] };
  expect(cleared.status).toBe('DRAFT');
  expect(cleared.providerSessionRef ?? null).toBeNull();
  expect(cleared.products).toMatchObject([{ productId: product!.id, featured: true, shopFeatured: false, shopSortOrder: null, shopPinned: false }]);
});
