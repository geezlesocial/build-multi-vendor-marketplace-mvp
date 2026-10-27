import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; seller-shipping tests may only use the guarded disposable database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const password = 'LocalDemoOnly-ChangeMe-123!';
const address = { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' };

async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(item => item.name === 'marketplace_csrf');
  expect(cookie?.value).toBeTruthy();
  return { 'x-csrf-token': cookie!.value };
}
async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function openAccount(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email);
  return { context, page };
}
async function close(accounts: Array<{ context: BrowserContext }>) {
  for (const account of accounts) await account.context.close();
}

async function createSellerFixture(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const template = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const user = await prisma.user.create({ data: { email: `shipping-${label}-${suffix}@example.test`, name: `Shipping ${label} ${suffix}`, role: Role.SELLER, passwordHash: template.passwordHash } });
  const seller = await prisma.seller.create({ data: { userId: user.id, status: SellerStatus.APPROVED } });
  const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Shipping Store ${label} ${suffix}`, slug: `shipping-store-${label}-${suffix}` } });
  await prisma.storeCurrencyOffer.create({ data: { storeId: store.id, currency: 'USD', displayEnabled: true, checkoutEnabled: true } });
  const product = await prisma.product.create({ data: {
    seller: { connect: { id: seller.id } }, productType: { connect: { slug: 'physical-product' } },
    name: `Shipping Product ${label} ${suffix}`, slug: `shipping-product-${label}-${suffix}`,
    description: 'Synthetic shipping regression fixture', priceMinor: 3500, status: ProductStatus.APPROVED,
    inventory: { create: { quantity: 8 } }
  } });
  const service = await prisma.sellerShippingService.create({ data: {
    sellerId: seller.id, name: `Courier ${label} ${suffix}`, enabled: true, supportsCod: true, feeMinor: 800, currency: 'USD',
    estimatedMinDays: 2, estimatedMaxDays: 4,
    zones: { create: { countryCode: 'US', regionKey: '', regionLabel: null, cityKey: '', cityLabel: null } }
  } });
  return { user, seller, store, product, service, suffix };
}

test.afterAll(async () => { await prisma.$disconnect(); });

test('seller shipping is tenant-scoped, permissioned, audited, and visible to admins', async ({ browser }) => {
  test.setTimeout(60_000);
  const owner = await openAccount(browser, 'seller.local@example.test');
  const admin = await openAccount(browser, 'admin.local@example.test');
  const buyer = await openAccount(browser, 'buyer.local@example.test');
  const fixture = await createSellerFixture('permissions');
  const fixtureOwner = await openAccount(browser, fixture.user.email);
  const staffTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { passwordHash: true } });
  const staffUser = await prisma.user.create({ data: { email: `shipping-staff-${fixture.suffix}@example.test`, name: 'Shipping Staff', role: Role.CASHIER, passwordHash: staffTemplate.passwordHash } });
  await prisma.sellerStaff.create({ data: { sellerId: fixture.seller.id, userId: staffUser.id, canManageShipping: false } });
  const staff = await openAccount(browser, staffUser.email);
  const accounts = [owner, admin, buyer, fixtureOwner, staff];
  try {
    expect((await buyer.page.request.get('/api/admin/shipping')).status()).toBe(403);
    expect((await owner.page.request.get('/api/seller/shipping')).status()).toBe(200);
    expect((await staff.page.request.get('/api/seller/shipping')).status()).toBe(403);

    const crossStore = await owner.page.request.post(`/api/seller/shipping/services/${fixture.service.id}/toggle`, { data: { enabled: false }, headers: await csrf(owner.page) });
    expect(crossStore.status()).toBe(404);

    const grant = await fixtureOwner.page.request.patch(`/api/seller/store-branding/staff/${staffUser.id}`, { data: { canManageShipping: true }, headers: await csrf(fixtureOwner.page) });
    expect(grant.status()).toBe(200);
    expect((await staff.page.request.get('/api/seller/shipping')).status()).toBe(200);
    const staffToggle = await staff.page.request.post(`/api/seller/shipping/services/${fixture.service.id}/toggle`, { data: { enabled: false }, headers: await csrf(staff.page) });
    expect(staffToggle.status()).toBe(200);
    await staff.page.request.post(`/api/seller/shipping/services/${fixture.service.id}/toggle`, { data: { enabled: true }, headers: await csrf(staff.page) });

    await fixtureOwner.page.goto('/dashboard?mode=seller&tab=shipping');
    await expect(fixtureOwner.page.getByRole('heading', { name: 'Shipping settings' })).toBeVisible();
    await fixtureOwner.page.getByLabel('Courier or service name').fill('Browser delivery');
    await fixtureOwner.page.getByLabel('Shipping fee in minor units (USD)').fill('275');
    await fixtureOwner.page.getByRole('button', { name: 'Save shipping service' }).click();
    await expect(fixtureOwner.page.getByRole('status').filter({ hasText: 'Shipping service saved.' })).toBeVisible();
    await expect(fixtureOwner.page.getByRole('heading', { name: 'Browser delivery', exact: true })).toBeVisible();

    const invalidZone = await owner.page.request.post('/api/seller/shipping/services', { data: {
      name: 'Ambiguous duplicate', feeMinor: 100, zones: [
        { countryCode: 'us', region: 'California', city: 'San Francisco' },
        { countryCode: 'US', region: ' california ', city: ' SAN  FRANCISCO ' }
      ]
    }, headers: await csrf(owner.page) });
    expect(invalidZone.status()).toBe(400);

    const adminView = await admin.page.request.get('/api/admin/shipping');
    expect(adminView.status()).toBe(200);
    expect((await adminView.json() as { services: { id: string }[] }).services.some(service => service.id === fixture.service.id)).toBeTruthy();
    const beforeAudit = await prisma.auditLog.count({ where: { action: 'PLATFORM_SETTINGS_CHANGED', entityId: 'default' } });
    const disabled = await admin.page.request.patch('/api/admin/platform/settings', { data: { sellerShippingEnabled: false, reason: 'Disposable shipping gate test' }, headers: await csrf(admin.page) });
    expect(disabled.status()).toBe(200);
    try {
      const blockedQuote = await buyer.page.request.post('/api/shipping/quote', { data: { address }, headers: await csrf(buyer.page) });
      expect(blockedQuote.status()).toBe(409);
    } finally {
      const enabled = await admin.page.request.patch('/api/admin/platform/settings', { data: { sellerShippingEnabled: true, reason: 'Restore disposable shipping gate test' }, headers: await csrf(admin.page) });
      expect(enabled.status()).toBe(200);
    }
    expect(await prisma.auditLog.count({ where: { action: 'PLATFORM_SETTINGS_CHANGED', entityId: 'default' } })).toBeGreaterThan(beforeAudit);

    await admin.page.goto('/admin/platform');
    await admin.page.getByRole('button', { name: 'Seller-managed shipping' }).click();
    await expect(admin.page.getByRole('heading', { name: 'Seller-managed shipping' })).toBeVisible();
    const fixtureServiceRow = admin.page.locator('.table .row').filter({ hasText: fixture.service.name });
    await expect(fixtureServiceRow).toHaveCount(1);
    await expect(fixtureServiceRow).toContainText(fixture.store.name);
  } finally { await close(accounts); }
});

test('multi-vendor checkout applies product shipping discounts, persists immutable snapshots, and rejects stale quotes', async ({ browser }) => {
  test.setTimeout(60_000);
  const buyer = await openAccount(browser, 'buyer.local@example.test');
  const second = await createSellerFixture('checkout');
  const secondSeller = await openAccount(browser, second.user.email);
  const accounts = [buyer, secondSeller];
  try {
    const cart = await buyer.page.request.get('/api/cart');
    for (const item of (await cart.json() as { items: { productId: string }[] }).items) {
      await buyer.page.request.patch(`/api/cart/items/${item.productId}`, { data: { quantity: 0 }, headers: await csrf(buyer.page) });
    }
    const demoProduct = (await (await buyer.page.request.get('/api/products?q=Demo%20Canvas%20Tote')).json() as { items: { id: string; priceMinor: number }[] }).items[0]!;
    const demoStore = await prisma.product.findUniqueOrThrow({ where: { id: demoProduct.id }, select: { sellerId: true, seller: { select: { store: { select: { name: true } } } } } });
    const demoStoreName = demoStore.seller?.store?.name;
    expect(demoStoreName).toBeTruthy();
    for (const productId of [demoProduct.id, second.product.id]) {
      const added = await buyer.page.request.post('/api/cart/items', { data: { productId, quantity: 1 }, headers: await csrf(buyer.page) });
      expect(added.status()).toBe(201);
    }
    const buyerId = (await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { id: true } })).id;
    const beforeModeDisabledOrders = await prisma.parentOrder.count({ where: { buyerId } });
    const beforeModeDisabledStock = await prisma.inventory.findUniqueOrThrow({ where: { productId: second.product.id } });
    await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { multiVendorEnabled: false } });
    try {
      const disabledModeCheckout = await buyer.page.request.post('/api/orders/checkout', { data: {
        buyerEmail: 'buyer.local@example.test', buyerName: 'Local Buyer', address, method: 'COD'
      }, headers: await csrf(buyer.page) });
      expect(disabledModeCheckout.status()).toBe(409);
      expect((await disabledModeCheckout.json() as { error: string }).error).toContain('multi-vendor mode is disabled');
      expect(await prisma.parentOrder.count({ where: { buyerId } })).toBe(beforeModeDisabledOrders);
      expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: second.product.id } })).quantity).toBe(beforeModeDisabledStock.quantity);
    } finally {
      await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { multiVendorEnabled: true } });
    }
    const demoService = await prisma.sellerShippingService.findUniqueOrThrow({ where: { id: 'local-demo-shipping-service' } });
    const beforeOutOfRangeOrders = await prisma.parentOrder.count({ where: { buyerId } });
    await prisma.sellerShippingService.update({ where: { id: demoService.id }, data: { feeMinor: 2_000_000_000 } });
    await prisma.sellerShippingService.update({ where: { id: second.service.id }, data: { feeMinor: 2_000_000_000 } });
    try {
      const outOfRangeQuote = await buyer.page.request.post('/api/shipping/quote', { data: { address }, headers: await csrf(buyer.page) });
      expect(outOfRangeQuote.status()).toBe(409);
      expect((await outOfRangeQuote.json() as { code: string }).code).toBe('ORDER_TOTAL_OUT_OF_RANGE');
      expect(await prisma.parentOrder.count({ where: { buyerId } })).toBe(beforeOutOfRangeOrders);
    } finally {
      await prisma.sellerShippingService.update({ where: { id: demoService.id }, data: { feeMinor: demoService.feeMinor } });
      await prisma.sellerShippingService.update({ where: { id: second.service.id }, data: { feeMinor: second.service.feeMinor } });
    }
    const beforeDisabledServiceOrderCount = await prisma.parentOrder.count({ where: { buyerId: (await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { id: true } })).id } });
    const disabledService = await secondSeller.page.request.post(`/api/seller/shipping/services/${second.service.id}/toggle`, { data: { enabled: false }, headers: await csrf(secondSeller.page) });
    expect(disabledService.status()).toBe(200);
    const unavailableQuote = await buyer.page.request.post('/api/shipping/quote', { data: { address }, headers: await csrf(buyer.page) });
    expect(unavailableQuote.status()).toBe(409);
    expect((await unavailableQuote.json() as { code: string }).code).toBe('SHIPPING_UNAVAILABLE');
    expect(await prisma.parentOrder.count({ where: { buyerId: (await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { id: true } })).id } })).toBe(beforeDisabledServiceOrderCount);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: second.product.id } })).quantity).toBe(8);
    const enabledService = await secondSeller.page.request.post(`/api/seller/shipping/services/${second.service.id}/toggle`, { data: { enabled: true }, headers: await csrf(secondSeller.page) });
    expect(enabledService.status()).toBe(200);
    await expect(prisma.sellerShippingDiscount.create({ data: {
      serviceId: second.service.id, name: 'Invalid fixed shipping discount', type: 'FIXED', amountMinor: null, basisPoints: null
    } })).rejects.toThrow(/constraint/i);
    await expect(prisma.sellerShippingDiscount.create({ data: {
      serviceId: second.service.id, name: 'Invalid percentage shipping discount', type: 'PERCENTAGE', amountMinor: null, basisPoints: null
    } })).rejects.toThrow(/constraint/i);
    const discount = await secondSeller.page.request.post('/api/seller/shipping/discounts', { data: { serviceId: second.service.id, name: 'Eligible product delivery discount', type: 'FIXED', amountMinor: 300, priority: 10, productIds: [second.product.id], minimumQuantity: 1, minimumSubtotalMinor: 3500 }, headers: await csrf(secondSeller.page) });
    expect(discount.status(), await discount.text()).toBe(201);

    const page = await buyer.context.newPage();
    await login(page, 'buyer.local@example.test');
    await page.goto('/checkout');
    await page.getByLabel('Address').fill(address.line1);
    await page.getByLabel('City').fill(address.city);
    await page.getByLabel('Region').fill(address.region);
    await page.getByLabel('Postal code').fill(address.postalCode);
    const quoteResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/shipping/quote' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Calculate shipping' }).click();
    const quoteResponse = await quoteResponsePromise;
    expect(quoteResponse.status(), await quoteResponse.text()).toBe(200);
    const shippingQuote = await quoteResponse.json() as { quoteToken: string; totalMinor: number; shipments: { sellerId: string; storeName: string }[] };
    expect(shippingQuote.shipments).toEqual(expect.arrayContaining([
      expect.objectContaining({ sellerId: demoStore.sellerId, storeName: demoStoreName }),
      expect.objectContaining({ sellerId: second.seller.id, storeName: second.store.name })
    ]));
    await expect(page.getByRole('combobox', { name: `Delivery service for ${demoStoreName}`, exact: true })).toBeVisible();
    await expect(page.getByLabel(new RegExp(`Delivery service for ${second.store.name}`))).toBeVisible();
    await expect(page.locator('.summary .total strong')).toHaveText('$69.00');
    await expect(page.locator('.summary')).toContainText('$3.00');

    const buyerRecord = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { id: true } });
    expect(shippingQuote.totalMinor).toBe(6900);
    const beforeCodLimitOrderCount = await prisma.parentOrder.count({ where: { buyerId: buyerRecord.id } });
    const beforeCodLimitStock = await prisma.inventory.findUniqueOrThrow({ where: { productId: second.product.id } });
    await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { codMaxMinor: 6800 } });
    const overCodLimit = await buyer.page.request.post('/api/orders/checkout', { data: {
      buyerEmail: 'buyer.local@example.test', buyerName: 'Local Buyer', address, method: 'COD', shippingQuoteToken: shippingQuote.quoteToken
    }, headers: await csrf(buyer.page) });
    expect(overCodLimit.status()).toBe(409);
    expect((await overCodLimit.json() as { error: string }).error).toContain('configured COD limit');
    expect(await prisma.parentOrder.count({ where: { buyerId: buyerRecord.id } })).toBe(beforeCodLimitOrderCount);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: second.product.id } })).quantity).toBe(beforeCodLimitStock.quantity);
    await prisma.marketplaceSettings.update({ where: { id: 'default' }, data: { codMaxMinor: null } });

    await page.getByRole('button', { name: 'Place order' }).click();
    const confirmation = page.locator('.orderConfirmation');
    await expect(confirmation).toContainText('$69.00');
    const cartAfterCheckout = await page.request.get('/api/cart');
    expect(cartAfterCheckout.ok()).toBeTruthy();
    expect((await cartAfterCheckout.json() as { items: unknown[] }).items).toHaveLength(0);
    const reference = (await confirmation.locator('dl div').filter({ hasText: 'Order reference' }).locator('dd').textContent())!.trim();
    const order = await prisma.parentOrder.findUniqueOrThrow({ where: { orderNumber: reference }, include: { sellerOrders: { include: { items: true } } } });
    expect(order.totalMinor).toBe(6900);
    expect(order.sellerOrders).toHaveLength(2);
    const snapshots = order.sellerOrders.map(sellerOrder => sellerOrder.shippingSnapshotJson as { serviceName: string; destination: { country: string }; feeMinor: number; discountMinor: number; shippingMinor: number; currency: string });
    expect(snapshots.every(snapshot => snapshot.destination.country === 'US' && snapshot.currency === 'USD')).toBeTruthy();
    expect(snapshots.map(snapshot => snapshot.shippingMinor).sort((a, b) => a - b)).toEqual([500, 500]);
    expect(snapshots.some(snapshot => snapshot.feeMinor === 800 && snapshot.discountMinor === 300)).toBeTruthy();
    await expect(prisma.sellerOrder.update({ where: { id: order.sellerOrders[0]!.id }, data: { shippingSnapshotJson: { changed: true } } })).rejects.toThrow(/immutable/i);
    const persisted = await prisma.sellerOrder.findMany({ where: { parentId: order.id } });
    expect(persisted.every(sellerOrder => sellerOrder.shippingSnapshotJson !== null)).toBeTruthy();

    const legacyOrder = await prisma.parentOrder.create({ data: {
      orderNumber: `MV-SHIPPING-LEGACY-${randomUUID()}`, buyerId: buyerRecord.id,
      buyerEmail: 'buyer.local@example.test', buyerName: 'Local Buyer', addressJson: address,
      totalMinor: 3500, currency: 'USD',
      sellerOrders: { create: { sellerId: second.seller.id, totalMinor: 3500 } }
    }, include: { sellerOrders: true } });
    await expect(prisma.sellerOrder.update({ where: { id: legacyOrder.sellerOrders[0]!.id }, data: { shippingSnapshotJson: { backfilled: true } } })).rejects.toThrow(/immutable/i);
    expect((await prisma.sellerOrder.findUniqueOrThrow({ where: { id: legacyOrder.sellerOrders[0]!.id } })).shippingSnapshotJson).toBeNull();

    const addAgain = await buyer.page.request.post('/api/cart/items', { data: { productId: second.product.id, quantity: 1 }, headers: await csrf(buyer.page) });
    expect(addAgain.status()).toBe(201);
    const freshQuoteResponse = await buyer.page.request.post('/api/shipping/quote', { data: { address }, headers: await csrf(buyer.page) });
    expect(freshQuoteResponse.status()).toBe(200);
    const freshQuote = await freshQuoteResponse.json() as { quoteToken: string; totalMinor: number };
    const current = await prisma.sellerShippingService.findUniqueOrThrow({ where: { id: second.service.id }, include: { zones: true } });
    const edited = await secondSeller.page.request.patch(`/api/seller/shipping/services/${current.id}`, { data: { name: current.name, feeMinor: current.feeMinor + 100, enabled: true, estimatedMinDays: current.estimatedMinDays, estimatedMaxDays: current.estimatedMaxDays, zones: current.zones.map(zone => ({ countryCode: zone.countryCode, region: zone.regionLabel ?? '', city: zone.cityLabel ?? '' })) }, headers: await csrf(secondSeller.page) });
    expect(edited.status()).toBe(200);
    const beforeStaleOrder = await prisma.parentOrder.count({ where: { buyerId: order.buyerId } });
    const staleCheckout = await buyer.page.request.post('/api/orders/checkout', { data: { buyerEmail: 'buyer.local@example.test', buyerName: 'Local Buyer', address, method: 'COD', shippingQuoteToken: freshQuote.quoteToken }, headers: await csrf(buyer.page) });
    expect(staleCheckout.status()).toBe(409);
    expect((await staleCheckout.json() as { code: string }).code).toBe('SHIPPING_QUOTE_STALE');
    expect(await prisma.parentOrder.count({ where: { buyerId: order.buyerId } })).toBe(beforeStaleOrder);
    expect(freshQuote.totalMinor).toBeGreaterThan(0);

    const noCoverage = await buyer.page.request.post('/api/shipping/quote', { data: { address: { ...address, country: 'CA' } }, headers: await csrf(buyer.page) });
    expect(noCoverage.status()).toBe(409);
  } finally {
    try {
      const cart = await buyer.page.request.get('/api/cart');
      for (const item of (await cart.json() as { items: { productId: string }[] }).items) {
        await buyer.page.request.patch(`/api/cart/items/${item.productId}`, { data: { quantity: 0 }, headers: await csrf(buyer.page) });
      }
    } catch { /* The disposable database is removed after the browser run. */ }
    await close(accounts);
  }
});
