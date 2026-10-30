import { expect, test, type Page } from '@playwright/test';
import { MarketplaceProductAdPlacement, MarketplaceProductAdStatus, PrismaClient } from '@prisma/client';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
if (!e2eDatabaseUrl) throw new Error('E2E_DATABASE_URL is required; marketplace-ad placement tests use only the guarded disposable database.');
validateE2EDatabaseURL(e2eDatabaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl } } });
const password = 'LocalDemoOnly-ChangeMe-123!';

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.afterAll(async () => prisma.$disconnect());

test('campaign placements filter real surfaces and category pages display selected ads', async ({ page }) => {
  const priorSettings = await prisma.marketplaceProductAdSettings.findUnique({ where: { id: 'default' } });
  const buyer = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { id: true } });
  const product = await prisma.product.findUniqueOrThrow({ where: { slug: 'demo-canvas-tote' }, select: { id: true, sellerId: true } });
  if (!product.sellerId) throw new Error('The seeded product must belong to the demo store.');
  const store = await prisma.store.findUniqueOrThrow({ where: { sellerId: product.sellerId }, select: { id: true } });
  const now = new Date();
  const ids: string[] = [];

  try {
    await prisma.marketplaceProductAdSettings.upsert({ where: { id: 'default' }, update: { enabled: true }, create: { id: 'default', enabled: true } });
    for (const [placement, headline] of [
      [MarketplaceProductAdPlacement.CATEGORY_PAGES, 'Category placement test'],
      [MarketplaceProductAdPlacement.BLOG_POSTS, 'Blog placement test']
    ] as const) {
      const ad = await prisma.marketplaceProductAd.create({ data: {
        ownerId: buyer.id,
        productId: product.id,
        storeId: store.id,
        status: MarketplaceProductAdStatus.APPROVED,
        headline,
        description: 'Disposable end-to-end campaign for placement verification.',
        placements: [placement],
        currency: 'USD',
        budgetMinor: 1000,
        reservedMinor: 1000,
        startsAt: now,
        endsAt: new Date(now.getTime() + 60 * 60_000),
        reviewedAt: now
      } });
      ids.push(ad.id);
    }

    const categoryAds = await page.request.get('/api/marketplace-ads/featured?placement=CATEGORY_PAGES');
    expect(categoryAds.ok()).toBeTruthy();
    const categoryItems = (await categoryAds.json()).items as { id: string }[];
    expect(categoryItems.map(item => item.id)).toContain(ids[0]);
    expect(categoryItems.map(item => item.id)).not.toContain(ids[1]);

    const blogAds = await page.request.get('/api/marketplace-ads/featured?placement=BLOG_POSTS');
    expect(blogAds.ok()).toBeTruthy();
    const blogItems = (await blogAds.json()).items as { id: string }[];
    expect(blogItems.map(item => item.id)).toContain(ids[1]);
    expect(blogItems.map(item => item.id)).not.toContain(ids[0]);

    const invalidPlacement = await page.request.get('/api/marketplace-ads/featured?placement=ADMIN_ONLY');
    expect(invalidPlacement.status()).toBe(400);

    const category = await page.request.get('/api/marketplace/categories/featured');
    expect(category.ok()).toBeTruthy();
    expect((await category.json()).items.some((item: { id: string }) => item.id === product.id)).toBeTruthy();

    await page.goto('/category/featured');
    await expect(page.getByRole('heading', { name: 'Featured', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sponsored in Featured' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Category placement test' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Blog placement test' })).toHaveCount(0);

    await login(page, 'buyer.local@example.test');
    await page.goto('/ads');
    await expect(page.getByRole('group', { name: 'Placements' })).toBeVisible();
    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.getByText('5 of 5 selected')).toBeVisible();
  } finally {
    if (ids.length) await prisma.marketplaceProductAd.deleteMany({ where: { id: { in: ids } } });
    if (priorSettings) await prisma.marketplaceProductAdSettings.update({ where: { id: 'default' }, data: { enabled: priorSettings.enabled } });
    else await prisma.marketplaceProductAdSettings.deleteMany({ where: { id: 'default' } });
  }
});
