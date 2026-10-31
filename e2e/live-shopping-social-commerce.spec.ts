import { randomUUID } from 'node:crypto';
import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import { expect, test } from '@playwright/test';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; live shopping tests must use the disposable E2E database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

test.describe.configure({ timeout: 90_000 });
test.afterAll(async () => prisma.$disconnect());

test('seller cannot attach another store’s product to a live show', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'seller.local@example.test', password: 'LocalDemoOnly-ChangeMe-123!' }
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf');
  expect(csrf).toBeTruthy();

  const sellerUser = await prisma.user.create({ data: {
    email: `live-foreign-${randomUUID()}@example.test`,
    name: 'Synthetic second-store seller',
    role: 'SELLER',
    passwordHash: 'synthetic-never-used-for-login'
  } });
  let foreignSellerId: string | undefined;
  let foreignProductId: string | undefined;
  try {
    const foreignSeller = await prisma.seller.create({ data: {
      userId: sellerUser.id,
      status: 'APPROVED',
      store: { create: { name: 'Synthetic second store' } }
    } });
    foreignSellerId = foreignSeller.id;
    const physicalType = await prisma.catalogProductType.findUniqueOrThrow({ where: { slug: 'physical-product' }, select: { id: true } });
    const foreignProduct = await prisma.product.create({ data: {
      sellerId: foreignSeller.id,
      productTypeId: physicalType.id,
      name: 'Foreign store product',
      slug: `foreign-live-${randomUUID()}`,
      description: 'Synthetic cross-store ownership test fixture.',
      priceMinor: 1200,
      status: 'APPROVED',
      inventory: { create: { quantity: 4 } }
    } });
    foreignProductId = foreignProduct.id;

    const response = await page.request.post('/api/seller/live-sessions', {
      headers: { 'x-csrf-token': csrf!.value },
      data: { title: 'Reject cross-store product', timezone: 'UTC', productIds: [foreignProduct.id] }
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'LIVE_PRODUCT_NOT_ELIGIBLE' });
    expect(await prisma.liveSession.count({ where: { title: 'Reject cross-store product' } })).toBe(0);
  } finally {
    if (foreignProductId) {
      await prisma.inventory.deleteMany({ where: { productId: foreignProductId } });
      await prisma.product.deleteMany({ where: { id: foreignProductId } });
    }
    if (foreignSellerId) {
      await prisma.store.deleteMany({ where: { sellerId: foreignSellerId } });
      await prisma.seller.deleteMany({ where: { id: foreignSellerId } });
    }
    await prisma.user.deleteMany({ where: { id: sellerUser.id } });
  }
});

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
