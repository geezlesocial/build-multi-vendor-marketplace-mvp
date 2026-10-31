import { expect, test, type Page } from '@playwright/test';
import { Role, SellerStatus, ProductStatus } from '@prisma/client';
import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { isDisposableWalletFundingDatabaseUrl } from '../apps/api/src/wallet-safety.js';

const adminEmail = 'admin.local@example.test';
const buyerEmail = 'buyer.local@example.test';
const demoPassword = 'LocalDemoOnly-ChangeMe-123!';
const sellerEmail = `growth-${randomUUID().slice(0, 10)}@example.test`;
const sellerPassword = 'Store-Growth-Disposable-E2E-Only-44!';
const databaseUrl = process.env.E2E_DATABASE_URL ?? '';
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
if (!isDisposableWalletFundingDatabaseUrl(databaseUrl, sandboxId)) {
  throw new Error('Store growth browser tests require a unique, loopback-only disposable database identity.');
}
if (!process.env.PASSWORD_PEPPER) throw new Error('PASSWORD_PEPPER is required for isolated Store growth fixtures.');

const prisma = createTestPrismaClient(databaseUrl);
const apiOrigin = `http://127.0.0.1:${Number(process.env.E2E_API_PORT ?? 4000)}`;
let store: { id: string; slug: string };
let product: { id: string; slug: string };
let categoryId: string;

async function signIn(page: Page, email: string, password = demoPassword) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const token = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(token).toBeTruthy();
  return { 'x-csrf-token': token! };
}

async function createPlan(page: Page) {
  const key = `growth-${randomUUID().slice(0, 12)}`;
  const response = await page.request.post('/api/admin/store-plans', {
    headers: await csrfHeaders(page),
    data: {
      key,
      name: 'Disposable Store Growth Plan',
      reason: 'Isolated Store growth entitlement verification',
      entitlements: {
        productLimit: 20,
        storeLimit: 1,
        vendorLimit: 1,
        staffSeatLimit: 2,
        allowedThemes: ['CLASSIC'],
        customDomainEligible: false,
        paymentConnectors: [],
        mobileTemplates: ['RESPONSIVE_STANDARD'],
        blogPostLimit: 3,
        contentPageLimit: 3,
        mediaStorageLimitBytes: 10_000_000,
        scheduledPublishingEnabled: false,
        advancedContentSeoEnabled: false,
        storeBusterEnabled: true,
        storeBusterCampaignLimit: 2,
        storeBusterMonthlyBudgetMinor: 0,
        emailMarketingEnabled: true,
        emailSubscriberLimit: 100,
        emailMonthlySendLimit: 500,
        affiliateToolsEnabled: true
      }
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  const created = await response.json() as { plan: { id: string }; version: { id: string } };
  const activated = await page.request.post(`/api/admin/store-plans/${created.plan.id}/activate`, {
    headers: await csrfHeaders(page), data: { versionId: created.version.id, reason: 'Activate disposable Store growth plan' }
  });
  expect(activated.status(), await activated.text()).toBe(200);
  const assigned = await page.request.post(`/api/admin/store-plan-stores/${store.id}/assignments`, {
    headers: await csrfHeaders(page), data: { versionId: created.version.id, reason: 'Assign disposable Store growth plan' }
  });
  expect([200, 201], await assigned.text()).toContain(assigned.status());
}

test.beforeAll(async () => {
  const category = await prisma.category.create({ data: { name: `Growth Interest ${randomUUID()}`, slug: `growth-interest-${randomUUID()}` } });
  categoryId = category.id;
  const passwordHash = await bcrypt.hash(`${sellerPassword}${process.env.PASSWORD_PEPPER}`, 4);
  const user = await prisma.user.create({
    data: {
      email: sellerEmail,
      name: 'Isolated Growth Seller',
      role: Role.SELLER,
      passwordHash,
      onboardingCompletedAt: new Date(),
      seller: { create: { status: SellerStatus.APPROVED, store: { create: { name: 'Growth Test Store', slug: `growth-test-${randomUUID().slice(0, 10)}` } } } }
    },
    include: { seller: { include: { store: true } } }
  });
  if (!user.seller?.store) throw new Error('Isolated Store growth seller fixture was not created.');
  store = { id: user.seller.store.id, slug: user.seller.store.slug };
  const createdProduct = await prisma.product.create({
    data: {
      seller: { connect: { id: user.seller.id } },
      productType: { connect: { slug: 'physical-product' } },
      category: { connect: { id: categoryId } },
      name: 'Growth Test Product',
      slug: `growth-product-${randomUUID().slice(0, 10)}`,
      description: 'Approved, in-stock product for isolated Store Buster tests.',
      priceMinor: 2500,
      status: ProductStatus.APPROVED,
      inventory: { create: { quantity: 5 } }
    },
    select: { id: true, slug: true }
  });
  product = createdProduct;
});

test.afterAll(async () => { await prisma.$disconnect(); });

test('free-compatible Store content can be created and published without paid publishing access', async ({ page }) => {
  await signIn(page, sellerEmail, sellerPassword);
  const content = await page.request.get('/api/seller/store-content');
  expect(content.ok(), await content.text()).toBeTruthy();
  const initial = await content.json() as { store: { slug: string }; entitlements: { blogPostLimit: number; contentPageLimit: number } };
  expect(initial.entitlements.blogPostLimit).toBeGreaterThan(0);
  expect(initial.entitlements.contentPageLimit).toBeGreaterThan(0);

  const slug = `growth-published-${randomUUID().slice(0, 10)}`;
  const draftResponse = await page.request.post('/api/seller/store-content/posts', {
    headers: await csrfHeaders(page),
    data: { title: 'A Store publishing test', slug, excerpt: 'Basic publishing is available.', body: [{ type: 'paragraph', text: 'Published in an isolated disposable browser test.' }] }
  });
  expect(draftResponse.status(), await draftResponse.text()).toBe(201);
  const draft = await draftResponse.json() as { id: string; status: string };
  expect(draft.status).toBe('DRAFT');
  const published = await page.request.post(`/api/seller/store-content/posts/${draft.id}/action`, { headers: await csrfHeaders(page), data: { action: 'publish' } });
  expect(published.status(), await published.text()).toBe(200);
  expect((await published.json()).status).toBe('PUBLISHED');

  const listing = await page.request.get(`/api/stores/${initial.store.slug}/content`);
  expect(listing.ok()).toBeTruthy();
  expect(await listing.json()).toMatchObject({ posts: [expect.objectContaining({ slug, title: 'A Store publishing test' })] });
  const publicDocument = await page.request.get(`${apiOrigin}/store/${initial.store.slug}/blog/${slug}`);
  expect(publicDocument.status()).toBe(200);
  const html = await publicDocument.text();
  expect(html).toContain('<title>A Store publishing test | Growth Test Store</title>');
  expect(html).toContain('name="description"');
  expect(html).toContain('Published in an isolated disposable browser test.');
});

test('plan-gated growth tools stay scoped, organic, and unavailable for delivery', async ({ page }) => {
  const admin = page;
  await signIn(admin, adminEmail);
  await createPlan(admin);

  const busterSettingsBefore = await prisma.storeBusterSettings.findUnique({ where: { id: 'default' } });
  const affiliateSettingsBefore = await prisma.marketplaceSettings.findUnique({ where: { id: 'default' }, select: { affiliateEnabled: true } });
  try {
    const settings = await admin.request.patch('/api/admin/store-buster/settings', {
      headers: await csrfHeaders(admin),
      data: { enabled: true, sponsoredEnabled: false, moderationRequired: true, maxMonthlyBudgetMinor: 0, maxCampaignsPerStore: 5, pricePerClickMinor: 0, pricePer100ViewsMinor: 0, minimumCampaignUsdMinor: 1000, maxCampaignDurationDays: 30, reason: 'Enable organic isolated test recommendations' }
    });
    expect(settings.status(), await settings.text()).toBe(200);

    const sellerContext = await page.context().browser()!.newContext();
    const buyerContext = await page.context().browser()!.newContext();
    try {
      const sellerPage = await sellerContext.newPage();
      await signIn(sellerPage, sellerEmail, sellerPassword);
      const quotaContent = await sellerPage.request.get('/api/seller/store-content');
      const quotaData = await quotaContent.json() as { entitlements: { blogPostLimit: number } };
      expect(quotaData.entitlements.blogPostLimit).toBe(3);
      for (const number of [2, 3]) {
        const withinLimit = await sellerPage.request.post('/api/seller/store-content/posts', {
          headers: await csrfHeaders(sellerPage),
          data: { title: `Quota post ${number}`, slug: `quota-post-${number}-${randomUUID().slice(0, 8)}`, body: [{ type: 'paragraph', text: 'Within the configured plan quota.' }] }
        });
        expect(withinLimit.status(), await withinLimit.text()).toBe(201);
      }
      const overLimit = await sellerPage.request.post('/api/seller/store-content/posts', {
        headers: await csrfHeaders(sellerPage),
        data: { title: 'Over quota post', slug: `quota-post-over-${randomUUID().slice(0, 8)}`, body: [{ type: 'paragraph', text: 'Must be rejected by the server.' }] }
      });
      expect(overLimit.status()).toBe(409);
      expect(await overLimit.json()).toMatchObject({ code: 'PLAN_LIMIT_REACHED', entitlement: 'blogPostLimit', limit: 3, upgradeRequired: true });
      const campaignResponse = await sellerPage.request.post('/api/seller/store-buster/campaigns', {
        headers: await csrfHeaders(sellerPage),
        data: { name: 'Organic category reach', goal: 'DISCOVERY', productIds: [product.id], audienceCategoryIds: [categoryId] }
      });
      expect(campaignResponse.status(), await campaignResponse.text()).toBe(201);
      const campaign = await campaignResponse.json() as { id: string; sponsored: boolean };
      expect(campaign.sponsored).toBe(false);
      const submitted = await sellerPage.request.post(`/api/seller/store-buster/campaigns/${campaign.id}/submit`, { headers: await csrfHeaders(sellerPage), data: {} });
      expect((await submitted.json()).status).toBe('PENDING_REVIEW');

      const approved = await admin.request.patch(`/api/admin/store-buster/campaigns/${campaign.id}/review`, { headers: await csrfHeaders(admin), data: { status: 'APPROVED', reason: 'Approve organic isolated test campaign' } });
      expect(approved.status()).toBe(200);

      const buyerPage = await buyerContext.newPage();
      await signIn(buyerPage, buyerEmail);
      await buyerPage.request.patch('/api/account/personalization', { headers: await csrfHeaders(buyerPage), data: { enabled: true } });
      const signal = await buyerPage.request.post('/api/store-buster/signals', { headers: await csrfHeaders(buyerPage), data: { type: 'SEARCH_CATEGORY', categoryId } });
      expect(signal.status()).toBe(204);
      const recommendations = await buyerPage.request.get('/api/store-buster/recommendations');
      expect(recommendations.status()).toBe(200);
      const recommendationBody = await recommendations.json() as { items: { campaignId: string; impressionToken: string; product: { id: string }; placement: string; reason: string }[] };
      expect(recommendationBody.items).toEqual([expect.objectContaining({ product: expect.objectContaining({ id: product.id, slug: product.slug }), placement: 'ORGANIC', reason: expect.stringContaining('Growth Interest') })]);
      expect(JSON.stringify(recommendationBody)).not.toContain(sellerEmail);
      expect(recommendationBody.items[0].impressionToken).toHaveLength(43);
      const clicked = await buyerPage.request.post(`/api/store-buster/campaigns/${campaign.id}/click`, { headers: await csrfHeaders(buyerPage), data: { impressionToken: recommendationBody.items[0].impressionToken } });
      expect(clicked.status()).toBe(204);
      const duplicateClick = await buyerPage.request.post(`/api/store-buster/campaigns/${campaign.id}/click`, { headers: await csrfHeaders(buyerPage), data: { impressionToken: recommendationBody.items[0].impressionToken } });
      expect(duplicateClick.status()).toBe(409);
      await buyerPage.request.patch('/api/account/personalization', { headers: await csrfHeaders(buyerPage), data: { enabled: false } });
      expect((await (await buyerPage.request.get('/api/store-buster/recommendations')).json()).items).toEqual([]);
      expect((await sellerPage.request.get('/api/seller/store-buster')).status()).toBe(200);

      const emailState = await (await sellerPage.request.get('/api/seller/email-marketing')).json() as { enabledForPlan: boolean; deliveryAvailable: boolean; subscribers: { email?: string; emailMasked?: string }[] };
      expect(emailState).toMatchObject({ enabledForPlan: true, deliveryAvailable: false });
      expect(emailState.subscribers.every(subscriber => !subscriber.email)).toBe(true);
      const emailDraft = await sellerPage.request.post('/api/seller/email-campaigns', { headers: await csrfHeaders(sellerPage), data: { name: 'Consent-safe draft', subject: 'Draft only', content: [{ type: 'paragraph', text: 'No email is sent by this test.' }] } });
      expect(emailDraft.status(), await emailDraft.text()).toBe(201);
      const subscription = await sellerPage.request.post(`/api/stores/${store.slug}/newsletter`, { headers: await csrfHeaders(sellerPage), data: { email: 'person@example.test', consent: true, consentSource: 'isolated-test' } });
      expect(subscription.status()).toBe(503);
      expect(await subscription.json()).toMatchObject({ code: 'STORE_EMAIL_DELIVERY_UNAVAILABLE' });

      await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { affiliateEnabled: true } });
      const affiliate = await sellerPage.request.patch('/api/seller/affiliate-program', { headers: await csrfHeaders(sellerPage), data: { enabled: true } });
      expect(affiliate.status()).toBe(200);
      expect((await (await sellerPage.request.get('/api/seller/affiliate-program')).json()).payoutRequestsAvailable).toBe(false);
    } finally {
      await sellerContext.close();
      await buyerContext.close();
    }
  } finally {
    if (busterSettingsBefore) await prisma.storeBusterSettings.update({ where: { id: 'default' }, data: { enabled: busterSettingsBefore.enabled, sponsoredEnabled: busterSettingsBefore.sponsoredEnabled, moderationRequired: busterSettingsBefore.moderationRequired, maxMonthlyBudgetMinor: busterSettingsBefore.maxMonthlyBudgetMinor, maxCampaignsPerStore: busterSettingsBefore.maxCampaignsPerStore, pricePerClickMinor: busterSettingsBefore.pricePerClickMinor, updatedById: busterSettingsBefore.updatedById } });
    if (affiliateSettingsBefore) await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { affiliateEnabled: affiliateSettingsBefore.affiliateEnabled } });
  }
});

test('buyers cannot access seller content, admin Store Buster controls, or managed-media upload', async ({ page }) => {
  await signIn(page, buyerEmail);
  const forbiddenContent = await page.request.post('/api/seller/store-content/posts', { headers: await csrfHeaders(page), data: {} });
  expect(forbiddenContent.status()).toBe(403);
  const forbiddenAdminSettings = await page.request.get('/api/admin/store-buster/settings');
  expect(forbiddenAdminSettings.status()).toBe(403);
  const forbiddenSellerGrowth = await page.request.get('/api/seller/store-buster');
  expect(forbiddenSellerGrowth.status()).toBe(403);

  const sellerPage = page;
  await signIn(sellerPage, sellerEmail, sellerPassword);
  const upload = await sellerPage.request.post('/api/seller/store-media/uploads', {
    headers: await csrfHeaders(sellerPage), data: { fileName: 'preview.png', contentType: 'image/png', sizeBytes: 2048 }
  });
  expect(upload.status()).toBe(503);
  expect(await upload.json()).toMatchObject({ error: expect.stringContaining('Managed browser uploads are not configured') });
});

test('quarantined and unreferenced media cannot be delivered publicly', async ({ page }) => {
  const seller = await prisma.user.findUniqueOrThrow({ where: { email: sellerEmail }, select: { id: true } });
  const quarantined = await prisma.mediaAsset.create({ data: {
    storageKey: `stores/${store.id}/media/quarantined-${randomUUID()}.webp`,
    originalName: 'quarantined.webp', safeName: 'quarantined.webp', kind: 'IMAGE', detectedMime: 'image/webp', sizeBytes: 12,
    checksum: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), uploaderId: seller.id, storeId: store.id,
    uploadStatus: 'COMPLETE', storageProvider: 'OBJECT', scanStatus: 'QUARANTINED'
  } });
  await prisma.productImage.create({ data: { productId: product.id, mediaAssetId: quarantined.id, url: `/content-media/${quarantined.id}`, alt: 'Quarantined test image' } });
  const approvedButUnpublished = await prisma.mediaAsset.create({ data: {
    storageKey: `stores/${store.id}/media/unreferenced-${randomUUID()}.webp`,
    originalName: 'unreferenced.webp', safeName: 'unreferenced.webp', kind: 'IMAGE', detectedMime: 'image/webp', sizeBytes: 12,
    checksum: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), uploaderId: seller.id, storeId: store.id,
    uploadStatus: 'COMPLETE', storageProvider: 'OBJECT', scanStatus: 'APPROVED'
  } });

  const quarantineResponse = await page.request.get(`${apiOrigin}/content-media/${quarantined.id}`);
  const unreferencedResponse = await page.request.get(`${apiOrigin}/content-media/${approvedButUnpublished.id}`);
  expect(quarantineResponse.status()).toBe(404);
  expect(unreferencedResponse.status()).toBe(404);

  await signIn(page, sellerEmail, sellerPassword);
  const draft = await page.request.post('/api/seller/store-content/pages', {
    headers: await csrfHeaders(page),
    data: { title: 'Quarantined media draft', slug: `quarantined-media-${randomUUID().slice(0, 8)}`, pageType: 'STANDARD', body: [{ type: 'image', mediaId: quarantined.id, alt: 'Still quarantined' }] }
  });
  expect(draft.status(), await draft.text()).toBe(201);
  const draftId = (await draft.json() as { id: string }).id;
  const publication = await page.request.post(`/api/seller/store-content/pages/${draftId}/action`, { headers: await csrfHeaders(page), data: { action: 'publish' } });
  expect(publication.status()).toBe(409);
  expect(await publication.json()).toMatchObject({ error: expect.stringContaining('quarantined') });
});
