import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; currency/commission tests require the guarded disposable database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const password = 'LocalDemoOnly-ChangeMe-123!';
const address = { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' };

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), `Synthetic fixture login failed with ${response.status()}.`).toBeTruthy();
}
async function csrf(page: Page) {
  const value = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(value).toBeTruthy();
  return { 'x-csrf-token': value! };
}
async function openAccount(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(); const page = await context.newPage(); await login(page, email); return { context, page };
}
async function fixtureSeller(label: string, templateHash: string, suffix: string) {
  const user = await prisma.user.create({ data: { email: `currency-${label}-${suffix}@example.test`, name: `Currency ${label} ${suffix}`, role: Role.SELLER, passwordHash: templateHash } });
  const seller = await prisma.seller.create({ data: { userId: user.id, status: SellerStatus.APPROVED } });
  const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Currency Store ${label} ${suffix}`, slug: `currency-store-${label}-${suffix}` } });
  await prisma.storeCurrencyOffer.create({ data: { storeId: store.id, currency: 'USD', displayEnabled: true, checkoutEnabled: true } });
  const product = await prisma.product.create({ data: { seller: { connect: { id: seller.id } }, productType: { connect: { slug: 'physical-product' } }, name: `Currency Product ${label} ${suffix}`, slug: `currency-product-${label}-${suffix}`, description: 'Synthetic currency and commission fixture', priceMinor: 3500, currency: 'USD', status: ProductStatus.APPROVED, inventory: { create: { quantity: 4 } } } });
  await prisma.sellerShippingService.create({ data: { sellerId: seller.id, name: `Local delivery ${label}`, feeMinor: 500, currency: 'USD', enabled: true, supportsCod: true, zones: { create: { countryCode: 'US', regionKey: '', regionLabel: null, cityKey: '', cityLabel: null } } } });
  await prisma.storeCurrencyOffer.create({ data: { storeId: store.id, currency: 'JPY', displayEnabled: true, checkoutEnabled: false } });
  return { user, seller, store, product };
}

test.afterAll(async () => { await prisma.$disconnect(); });

test('admin commission policy creation serializes versions and persists each audit record', async ({ browser }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const user = await prisma.user.create({ data: { email: `commission-lock-seller-${suffix}@example.test`, name: `Commission Lock Seller ${suffix}`, role: Role.SELLER, passwordHash: sellerTemplate.passwordHash } });
  const seller = await prisma.seller.create({ data: { userId: user.id, status: SellerStatus.APPROVED } });
  const store = await prisma.store.create({ data: { sellerId: seller.id, name: `Commission Lock Store ${suffix}`, slug: `commission-lock-store-${suffix}` } });
  const admin = await openAccount(browser, 'admin.local@example.test');

  try {
    const csrfHeaders = await csrf(admin.page);
    const responses = await Promise.all([
      admin.page.request.post('/api/admin/seller-commission-policies', { data: { storeId: store.id, type: 'PERCENTAGE', currency: 'USD', basisPoints: 750, reason: 'Concurrent commission policy one' }, headers: csrfHeaders }),
      admin.page.request.post('/api/admin/seller-commission-policies', { data: { storeId: store.id, type: 'PERCENTAGE', currency: 'USD', basisPoints: 900, reason: 'Concurrent commission policy two' }, headers: csrfHeaders })
    ]);
    const responseBodies = await Promise.all(responses.map(response => response.text()));
    expect(responses.map(response => response.status()), responseBodies.join('\n')).toEqual([201, 201]);
    const created = responseBodies.map(body => JSON.parse(body) as { id: string; version: number; status: string });
    expect(created.map(policy => policy.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(created.every(policy => policy.status === 'DRAFT')).toBe(true);

    const persisted = await prisma.sellerCommissionPolicyVersion.findMany({
      where: { id: { in: created.map(policy => policy.id) }, storeId: store.id },
      orderBy: { version: 'asc' }
    });
    expect(persisted.map(policy => policy.version)).toEqual([1, 2]);
    expect(persisted.map(policy => policy.id).sort()).toEqual(created.map(policy => policy.id).sort());

    const auditRows = await prisma.auditLog.findMany({
      where: {
        action: 'SELLER_COMMISSION_POLICY_DRAFT_CREATED',
        entity: 'SellerCommissionPolicyVersion',
        entityId: { in: created.map(policy => policy.id) }
      }
    });
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map(row => row.entityId).sort()).toEqual(created.map(policy => policy.id).sort());
  } finally {
    await admin.context.close();
  }
});

test('store display estimates, checkout currency, COD eligibility and commission reversals remain distinct and tenant-scoped', async ({ browser }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 10);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const buyerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { passwordHash: true } });
  const sellers = [await fixtureSeller('one', sellerTemplate.passwordHash, suffix), await fixtureSeller('two', sellerTemplate.passwordHash, suffix)];
  const buyer = await prisma.user.create({ data: { email: `currency-buyer-${suffix}@example.test`, name: 'Currency Test Buyer', role: Role.BUYER, passwordHash: buyerTemplate.passwordHash } });
  const rate = await prisma.exchangeRateSnapshot.create({ data: { baseCurrency: 'USD', quoteCurrency: 'JPY', rate: '150', provider: `e2e-${suffix}`, sourceDate: new Date(new Date().toISOString().slice(0, 10)), fetchedAt: new Date() } });
  expect(rate.provider).toContain('e2e-');
  const admin = await openAccount(browser, 'admin.local@example.test');
  const buyerAccount = await openAccount(browser, buyer.email);
  const sellerAccounts = await Promise.all(sellers.map(store => openAccount(browser, store.user.email)));
  try {
    const deniedCurrencies = await buyerAccount.page.request.get('/api/admin/currencies');
    expect(deniedCurrencies.status()).toBe(403);
    const deniedPolicies = await sellerAccounts[0]!.page.request.get('/api/admin/seller-commission-policies');
    expect(deniedPolicies.status()).toBe(403);

    const policyResponse = await admin.page.request.post('/api/admin/seller-commission-policies', { data: { storeId: sellers[0]!.store.id, type: 'PERCENTAGE', currency: 'USD', basisPoints: 1000, reason: 'Synthetic E2E commission rule' }, headers: await csrf(admin.page) });
    expect(policyResponse.status(), await policyResponse.text()).toBe(201);
    const policy = await policyResponse.json() as { id: string; version: number };
    const activated = await admin.page.request.post(`/api/admin/seller-commission-policies/${policy.id}/activate`, { data: { reason: 'Synthetic E2E policy activation' }, headers: await csrf(admin.page) });
    expect(activated.ok(), await activated.text()).toBeTruthy();

    const buyerResponse = await buyerAccount.page.request.get('/api/currency/cart-options');
    expect(buyerResponse.ok(), await buyerResponse.text()).toBeTruthy();
    const options = await buyerResponse.json() as { checkoutCurrency: string; displayCurrencies: { code: string }[] };
    expect(options.checkoutCurrency).toBe('USD');

    await buyerAccount.page.goto(`/store/${sellers[0]!.store.slug}`);
    await expect(buyerAccount.page.getByRole('heading', { name: sellers[0]!.store.name })).toBeVisible();
    await buyerAccount.page.getByLabel('Store display currency').selectOption('JPY');
    await expect(buyerAccount.page.getByText(/Estimated display prices/)).toBeVisible();
    const previewResponse = await buyerAccount.page.request.get(`/api/stores/${sellers[0]!.store.slug}/currency-preview?currency=JPY`);
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    const preview = await previewResponse.json() as { items: { productId: string; estimatedAmountMinor: number; rate: { purpose?: string; estimateOnly: boolean } }[]; note: string };
    expect(preview.items.find(item => item.productId === sellers[0]!.product.id)?.estimatedAmountMinor).toBe(5250);
    expect(preview.items[0]?.rate.estimateOnly).toBe(true);
    expect(preview.note).toContain('checkout and payment use the configured platform charge currency');

    const buyerHeaders = await csrf(buyerAccount.page);
    for (const store of sellers) {
      const added = await buyerAccount.page.request.post('/api/cart/items', { data: { productId: store.product.id, quantity: 1 }, headers: buyerHeaders });
      expect(added.status(), await added.text()).toBe(201);
    }
    await buyerAccount.page.goto('/checkout');
    await expect(buyerAccount.page.getByRole('heading', { name: 'Complete your order' })).toBeVisible();
    await buyerAccount.page.getByLabel('Name').fill('Currency Test Buyer');
    await buyerAccount.page.getByLabel('Email').fill(buyer.email);
    await buyerAccount.page.getByLabel('Address').fill(address.line1);
    await buyerAccount.page.getByLabel('City').fill(address.city);
    await buyerAccount.page.getByLabel('Region').fill(address.region);
    await buyerAccount.page.getByLabel('Postal code').fill(address.postalCode);
    await buyerAccount.page.getByLabel('Country code').fill(address.country);
    await buyerAccount.page.getByLabel('Display estimate (not payment currency)').selectOption('JPY');
    await buyerAccount.page.getByRole('button', { name: 'Calculate shipping' }).click();
    await expect(buyerAccount.page.getByLabel(/Delivery service for Currency Store/)).toHaveCount(2);
    await expect(buyerAccount.page.getByText(/Estimated display total:/)).toBeVisible();
    const checkoutResponsePromise = buyerAccount.page.waitForResponse(response => response.url().includes('/api/orders/checkout') && response.request().method() === 'POST');
    await buyerAccount.page.getByRole('button', { name: 'Place order' }).click();
    const checkoutResponse = await checkoutResponsePromise;
    expect(checkoutResponse.status(), await checkoutResponse.text()).toBe(201);
    const orderResult = await checkoutResponse.json() as { orderId: string; totalMinor: number; shippingTotalMinor: number; currency: string; displayEstimate: { currency: string; itemTotalMinor: number; shippingTotalMinor: number; totalMinor: number } | null };
    expect(orderResult.currency).toBe('USD');
    expect(orderResult.totalMinor).toBe(8000);
    expect(orderResult.shippingTotalMinor).toBe(1000);
    expect(orderResult.displayEstimate?.currency).toBe('JPY');
    expect(orderResult.displayEstimate).toMatchObject({ itemTotalMinor: 10500, shippingTotalMinor: 1500, totalMinor: 12000 });
    expect(new URL(buyerAccount.page.url()).searchParams.get('order')).toBe(orderResult.orderId);
    const savedOrderResponse = await buyerAccount.page.request.get(`/api/dashboard/orders/${orderResult.orderId}`);
    expect(savedOrderResponse.status(), await savedOrderResponse.text()).toBe(200);
    const savedOrder = await savedOrderResponse.json() as { displayEstimate: { currency: string; itemTotalMinor: number; shippingTotalMinor: number; totalMinor: number; purpose: string; rateSnapshots: { sourceDate: string; fetchedAt: string }[] } | null };
    expect(savedOrder.displayEstimate).toMatchObject({ currency: 'JPY', itemTotalMinor: 10500, shippingTotalMinor: 1500, totalMinor: 12000, purpose: 'DISPLAY_ESTIMATE_ONLY' });
    expect(savedOrder.displayEstimate?.rateSnapshots.length).toBeGreaterThan(0);
    await expect(buyerAccount.page.locator('.total')).toContainText('$80.00');
    await expect(buyerAccount.page.locator('.displayEstimate')).toContainText('¥12,000');
    await expect(buyerAccount.page.locator('.displayEstimate')).toContainText('USD order total: $80.00');
    let recalculatedAfterReload = false;
    const countEstimateRequest = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && request.url().includes('/api/currency/cart-estimate')) recalculatedAfterReload = true;
    };
    buyerAccount.page.on('request', countEstimateRequest);
    await buyerAccount.page.reload();
    await expect(buyerAccount.page.getByText('Order confirmed', { exact: true })).toBeVisible();
    await expect(buyerAccount.page.locator('.total')).toContainText('$80.00');
    await expect(buyerAccount.page.locator('.displayEstimate')).toContainText('¥12,000');
    await expect(buyerAccount.page.locator('.displayEstimate')).toContainText('saved with this order');
    buyerAccount.page.off('request', countEstimateRequest);
    expect(recalculatedAfterReload).toBe(false);
    await expect(buyerAccount.page.getByText('Order confirmed', { exact: true })).toBeVisible();
    const order = await prisma.parentOrder.findUniqueOrThrow({ where: { id: orderResult.orderId }, include: { payment: true, sellerOrders: { include: { items: true } } } });
    expect(order.payment?.status).toBe('PENDING');
    expect(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: order.id } } })).toBe(0);
    expect(order.sellerOrders).toHaveLength(2);
    for (const sellerOrder of order.sellerOrders) {
      const item = sellerOrder.items[0]!;
      expect(item.currencySnapshot).toBe('USD');
      expect(item.displayCurrency).toBe('JPY');
      expect(item.displayAmountMinor).toBe(5250);
      expect(item.fxSnapshotJson).toMatchObject({ purpose: 'DISPLAY_ESTIMATE_ONLY', rounding: 'HALF_UP' });
    }
    const beforeCollect = await admin.page.request.post(`/api/orders/${order.id}/cod-collect`, { data: {}, headers: await csrf(admin.page) });
    expect(beforeCollect.status()).toBe(409);
    expect((await beforeCollect.json() as { code: string }).code).toBe('COD_DELIVERY_REQUIRED');

    for (let index = 0; index < sellers.length; index += 1) {
      const sellerOrder = order.sellerOrders.find(row => row.sellerId === sellers[index]!.seller.id)!;
      const shipmentUrl = `/api/sellers/${sellers[index]!.seller.id}/orders/${sellerOrder.id}/shipping`;
      for (const status of ['SHIPPED', 'DELIVERED'] as const) {
        const shipment = await sellerAccounts[index]!.page.request.patch(shipmentUrl, { data: { status, carrier: 'Synthetic E2E Courier', trackingNumber: `E2E-${sellerOrder.id}`, trackingUrl: `https://tracking.example.test/${sellerOrder.id}`, note: `Synthetic ${status.toLowerCase()} confirmation` }, headers: await csrf(sellerAccounts[index]!.page) });
        expect(shipment.ok(), await shipment.text()).toBeTruthy();
      }
    }
    const collected = await admin.page.request.post(`/api/orders/${order.id}/cod-collect`, { data: {}, headers: await csrf(admin.page) });
    expect(collected.ok(), await collected.text()).toBeTruthy();
    const ledger = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrder: { parentId: order.id } } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ sellerId: sellers[0]!.seller.id, entryType: 'ACCRUAL', amountMinor: 350, eligibleBaseMinor: 3500, currency: 'USD' });
    const sellerLedger = await sellerAccounts[0]!.page.request.get('/api/seller/commissions');
    expect(sellerLedger.ok()).toBeTruthy();
    expect((await sellerLedger.json() as { entries: { sellerId: string }[] }).entries.every(entry => entry.sellerId === sellers[0]!.seller.id)).toBe(true);
    const otherSellerLedger = await sellerAccounts[1]!.page.request.get('/api/seller/commissions');
    expect(otherSellerLedger.ok()).toBeTruthy();
    expect((await otherSellerLedger.json() as { entries: { sellerId: string }[] }).entries.some(entry => entry.sellerId === sellers[0]!.seller.id)).toBe(false);

    const codItem = order.sellerOrders.find(row => row.sellerId === sellers[0]!.seller.id)!.items[0]!;
    const missingSourceReview = await prisma.sellerCommissionReviewEvent.create({ data: { parentOrderId: order.id, provider: 'SYNTHETIC', providerEventId: `refund-${suffix}`, amountMinor: 1000, currency: 'USD', idempotencyKey: `review-${suffix}`, reason: 'Synthetic invalid source allocation test' } });
    const missingSource = await admin.page.request.post(`/api/admin/seller-commission-reviews/${missingSourceReview.id}/resolve`, { data: { allocations: [{ orderItemId: codItem.id, refundMinor: 1000 }], reason: 'Reject a review without a verified provider source' }, headers: await csrf(admin.page) });
    expect(missingSource.status()).toBe(409);
    expect((await missingSource.json() as { code: string }).code).toBe('COMMISSION_REFUND_EVENT_MISSING');
    expect((await prisma.sellerCommissionReviewEvent.findUniqueOrThrow({ where: { id: missingSourceReview.id } })).status).toBe('NEEDS_ALLOCATION');
    expect(await prisma.sellerCommissionLedgerEntry.count({ where: { sellerOrder: { parentId: order.id }, entryType: 'REVERSAL' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'SELLER_COMMISSION_REFUND_ALLOCATION_POSTED', entityId: missingSourceReview.id } })).toBe(0);

    // Represent the persisted result of a valid, signature-verified Stripe
    // partial-refund webhook without making any provider/network call.
    const paidSellerOrder = order.sellerOrders.find(row => row.sellerId === sellers[0]!.seller.id)!;
    const codAccrual = await prisma.sellerCommissionLedgerEntry.findFirstOrThrow({ where: { sellerOrderId: paidSellerOrder.id, orderItemId: codItem.id, entryType: 'ACCRUAL' } });
    const refundOrder = await prisma.parentOrder.create({ data: {
      orderNumber: `MV-REFUND-${suffix}`, buyerEmail: buyer.email, buyerName: buyer.name, addressJson: address,
      totalMinor: codItem.unitPriceMinor, currency: 'USD', status: 'CONFIRMED',
      sellerOrders: { create: {
        sellerId: sellers[0]!.seller.id, totalMinor: codItem.unitPriceMinor,
        commissionPolicyVersionId: paidSellerOrder.commissionPolicyVersionId,
        commissionSnapshotJson: paidSellerOrder.commissionSnapshotJson!,
        items: { create: { productId: sellers[0]!.product.id, productName: codItem.productName, unitPriceMinor: codItem.unitPriceMinor, quantity: 1, currencySnapshot: 'USD' } }
      } },
      payment: { create: { method: 'STRIPE', status: 'PAID', providerRef: `pi_synthetic_refund_${suffix}`, paidAt: new Date() } }
    }, include: { sellerOrders: { include: { items: true } } } });
    const refundSellerOrder = refundOrder.sellerOrders[0]!;
    const refundItem = refundSellerOrder.items[0]!;
    await prisma.sellerCommissionLedgerEntry.create({ data: {
      sellerId: sellers[0]!.seller.id, sellerOrderId: refundSellerOrder.id, orderItemId: refundItem.id,
      policyVersionId: codAccrual.policyVersionId, entryType: 'ACCRUAL', amountMinor: codAccrual.amountMinor,
      eligibleBaseMinor: refundItem.unitPriceMinor, currency: 'USD', idempotencyKey: `e2e-refund-accrual-${suffix}`,
      sourceEventId: `evt_synthetic_capture_${suffix}`
    } });
    const refundEventId = `evt_synthetic_refund_${suffix}`;
    const review = await prisma.$transaction(async tx => {
      await tx.processedWebhookEvent.create({ data: {
        provider: 'STRIPE', eventId: refundEventId, eventType: 'charge.refunded', parentOrderId: refundOrder.id,
        amountMinor: 1000, currency: 'USD', providerTotalMinor: refundOrder.totalMinor,
        providerObjectRef: `pi_synthetic_refund_${suffix}`, reviewReason: null
      } });
      return tx.sellerCommissionReviewEvent.create({ data: {
        parentOrderId: refundOrder.id, provider: 'STRIPE', providerEventId: refundEventId, amountMinor: 1000,
        currency: 'USD', idempotencyKey: `seller-commission:refund-review:STRIPE:${refundEventId}`, reason: 'Synthetic verified partial-refund fixture'
      } });
    });
    const allocated = await admin.page.request.post(`/api/admin/seller-commission-reviews/${review.id}/resolve`, { data: { allocations: [{ orderItemId: refundItem.id, refundMinor: 1000 }], reason: 'Synthetic item-level refund allocation' }, headers: await csrf(admin.page) });
    expect(allocated.ok(), await allocated.text()).toBeTruthy();
    const finalEntries = await prisma.sellerCommissionLedgerEntry.findMany({ where: { sellerOrderId: refundSellerOrder.id, orderItemId: refundItem.id }, orderBy: { createdAt: 'asc' } });
    expect(finalEntries.map(entry => entry.amountMinor)).toEqual([350, -100]);
    expect(finalEntries.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(250);
    const duplicateReview = await admin.page.request.post(`/api/admin/seller-commission-reviews/${review.id}/resolve`, { data: { allocations: [{ orderItemId: refundItem.id, refundMinor: 1000 }], reason: 'Duplicate should not post' }, headers: await csrf(admin.page) });
    expect(duplicateReview.status()).toBe(404);

    const checkoutInput = { buyerEmail: buyer.email, buyerName: buyer.name, address, method: 'COD' };
    await prisma.currencyCatalogEntry.update({ where: { code: 'USD' }, data: { checkoutEnabled: false } });
    try {
      const platformDisabled = await buyerAccount.page.request.post('/api/orders/checkout', { data: checkoutInput, headers: buyerHeaders });
      expect(platformDisabled.status()).toBe(409);
      expect((await platformDisabled.json() as { code: string }).code).toBe('CHECKOUT_CURRENCY_UNAVAILABLE');
    } finally {
      await prisma.currencyCatalogEntry.update({ where: { code: 'USD' }, data: { checkoutEnabled: true } });
    }

    const addedForStoreGate = await buyerAccount.page.request.post('/api/cart/items', { data: { productId: sellers[0]!.product.id, quantity: 1 }, headers: buyerHeaders });
    expect(addedForStoreGate.status()).toBe(201);
    await prisma.storeCurrencyOffer.update({ where: { storeId_currency: { storeId: sellers[0]!.store.id, currency: 'USD' } }, data: { checkoutEnabled: false } });
    try {
      const storeDisabled = await buyerAccount.page.request.post('/api/orders/checkout', { data: checkoutInput, headers: buyerHeaders });
      expect(storeDisabled.status()).toBe(409);
      expect((await storeDisabled.json() as { code: string }).code).toBe('STORE_CHECKOUT_CURRENCY_UNAVAILABLE');
    } finally {
      await prisma.storeCurrencyOffer.update({ where: { storeId_currency: { storeId: sellers[0]!.store.id, currency: 'USD' } }, data: { checkoutEnabled: true } });
      await prisma.cartItem.deleteMany({ where: { cart: { userId: buyer.id } } });
    }
  } finally {
    await buyerAccount.context.close(); await admin.context.close();
    for (const account of sellerAccounts) await account.context.close();
  }
});

test('seller currency settings are scoped, audited, and serialize manual-rate versions', async ({ browser }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const buyerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { passwordHash: true } });
  const fixture = await fixtureSeller('settings', sellerTemplate.passwordHash, suffix);
  const otherFixture = await fixtureSeller('other', sellerTemplate.passwordHash, suffix);
  const deniedStaffUser = await prisma.user.create({ data: { email: `currency-staff-denied-${suffix}@example.test`, name: `Currency Staff Denied ${suffix}`, role: Role.CASHIER, passwordHash: buyerTemplate.passwordHash } });
  const allowedStaffUser = await prisma.user.create({ data: { email: `currency-staff-allowed-${suffix}@example.test`, name: `Currency Staff Allowed ${suffix}`, role: Role.CASHIER, passwordHash: buyerTemplate.passwordHash } });
  await prisma.sellerStaff.createMany({ data: [
    { sellerId: fixture.seller.id, userId: deniedStaffUser.id, canManageCurrency: false },
    { sellerId: fixture.seller.id, userId: allowedStaffUser.id, canManageCurrency: true }
  ] });
  const owner = await openAccount(browser, fixture.user.email);
  const deniedStaff = await openAccount(browser, deniedStaffUser.email);
  const allowedStaff = await openAccount(browser, allowedStaffUser.email);
  const buyer = await openAccount(browser, 'buyer.local@example.test');

  try {
    const ownerSettings = await owner.page.request.get('/api/seller/store/currency-settings');
    expect(ownerSettings.status(), await ownerSettings.text()).toBe(200);
    expect((await ownerSettings.json() as { store: { id: string } }).store.id).toBe(fixture.store.id);
    expect((await deniedStaff.page.request.get('/api/seller/store/currency-settings')).status()).toBe(403);
    expect((await buyer.page.request.get('/api/seller/store/currency-settings')).status()).toBe(403);
    const allowedSettings = await allowedStaff.page.request.get('/api/seller/store/currency-settings');
    expect(allowedSettings.status(), await allowedSettings.text()).toBe(200);
    expect((await allowedSettings.json() as { store: { id: string } }).store.id).toBe(fixture.store.id);

    const effectiveFrom = new Date(Date.now() - 5_000).toISOString();
    const validRate = { baseCurrency: 'USD', quoteCurrency: 'JPY', rate: '150', effectiveFrom, reason: 'Synthetic store display rate' };
    const createdRate = await allowedStaff.page.request.post('/api/seller/store/fx-overrides', { data: validRate, headers: await csrf(allowedStaff.page) });
    expect(createdRate.status(), await createdRate.text()).toBe(201);
    const rateBody = await createdRate.json() as { id: string; storeId: string; createdById: string; version: number };
    expect(rateBody).toMatchObject({ storeId: fixture.store.id, createdById: allowedStaffUser.id, version: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'MANUAL_FX_RATE_VERSION_CREATED', entityId: rateBody.id, actorId: allowedStaffUser.id } })).toBe(1);

    const sameTime = new Date(Date.now() + 60_000).toISOString();
    const concurrentPayload = { ...validRate, quoteCurrency: 'EUR', effectiveFrom: sameTime, reason: 'Concurrent synthetic display rate' };
    const concurrent = await Promise.all([
      allowedStaff.page.request.post('/api/seller/store/fx-overrides', { data: concurrentPayload, headers: await csrf(allowedStaff.page) }),
      allowedStaff.page.request.post('/api/seller/store/fx-overrides', { data: concurrentPayload, headers: await csrf(allowedStaff.page) })
    ]);
    const concurrentBodies = await Promise.all(concurrent.map(response => response.text()));
    expect(concurrent.map(response => response.status()).sort()).toEqual([201, 409]);
    const successfulConcurrentBody = JSON.parse(concurrentBodies[concurrent.findIndex(response => response.status() === 201)]!) as { id: string; version: number };
    expect(successfulConcurrentBody.version).toBe(1);
    expect(await prisma.manualExchangeRateVersion.count({ where: { storeId: fixture.store.id, quoteCurrency: 'EUR' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'MANUAL_FX_RATE_VERSION_CREATED', entityId: successfulConcurrentBody.id } })).toBe(1);

    await owner.page.goto('/seller/currency');
    await expect(owner.page.getByRole('heading', { name: 'Currency and display' })).toBeVisible();
    const yenOffer = owner.page.locator('.currencyOfferList label').filter({ hasText: 'JPY · Japanese Yen' });
    await yenOffer.getByRole('checkbox').check();
    await owner.page.getByLabel('Reason for settings change').fill('Offer JPY display estimate in isolated test');
    await owner.page.getByRole('button', { name: 'Save currency settings' }).click();
    await expect(owner.page.locator('p[role="status"]').filter({ hasText: 'Store currency settings saved and audited.' })).toBeVisible();
    const savedOffer = await prisma.storeCurrencyOffer.findUniqueOrThrow({ where: { storeId_currency: { storeId: fixture.store.id, currency: 'JPY' } } });
    expect(savedOffer).toMatchObject({ displayEnabled: true, checkoutEnabled: false });
    const publicCurrencies = await owner.page.request.get(`/api/stores/${fixture.store.slug}/currencies`);
    expect(publicCurrencies.ok(), await publicCurrencies.text()).toBeTruthy();
    const currencies = await publicCurrencies.json() as { currencies: { code: string; displayAvailable: boolean; checkoutAvailable: boolean }[] };
    expect(currencies.currencies.find(currency => currency.code === 'JPY')).toMatchObject({ displayAvailable: true, checkoutAvailable: false });

    const unauthorizedRate = await deniedStaff.page.request.post('/api/seller/store/fx-overrides', { data: { ...validRate, quoteCurrency: 'GBP', effectiveFrom: new Date(Date.now() + 120_000).toISOString() }, headers: await csrf(deniedStaff.page) });
    expect(unauthorizedRate.status()).toBe(403);
    const crossStoreAttempt = await allowedStaff.page.request.post('/api/seller/store/fx-overrides', { data: { ...validRate, storeId: otherFixture.store.id }, headers: await csrf(allowedStaff.page) });
    expect(crossStoreAttempt.status()).toBe(400);
    expect(await prisma.manualExchangeRateVersion.count({ where: { storeId: otherFixture.store.id, quoteCurrency: 'JPY' } })).toBe(0);
  } finally {
    await owner.context.close(); await deniedStaff.context.close(); await allowedStaff.context.close(); await buyer.context.close();
  }
});

test('mixed Store listing currencies cannot be combined into an unsupported checkout total', async ({ browser }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const buyerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'buyer.local@example.test' }, select: { passwordHash: true } });
  const store = await fixtureSeller('mixed-currency', sellerTemplate.passwordHash, suffix);
  const buyer = await prisma.user.create({ data: { email: `mixed-currency-buyer-${suffix}@example.test`, name: 'Mixed Currency Buyer', role: Role.BUYER, passwordHash: buyerTemplate.passwordHash } });
  const account = await openAccount(browser, buyer.email);
  const headers = await csrf(account.page);
  try {
    await prisma.product.update({ where: { id: store.product.id }, data: { currency: 'PHP' } });
    const added = await account.page.request.post('/api/cart/items', { data: { productId: store.product.id, quantity: 1 }, headers });
    expect(added.status(), await added.text()).toBe(201);
    const optionsResponse = await account.page.request.get('/api/currency/cart-options');
    expect(optionsResponse.ok(), await optionsResponse.text()).toBeTruthy();
    const options = await optionsResponse.json() as { checkoutCompatible: boolean; checkoutCurrencies: string[]; error: string | null };
    expect(options).toMatchObject({ checkoutCompatible: false, checkoutCurrencies: [], error: expect.any(String) });
    const blocked = await account.page.request.post('/api/orders/checkout', { data: { buyerName: buyer.name, buyerEmail: buyer.email, address, method: 'COD' }, headers });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json() as { code: string }).code).toBe('CHECKOUT_CURRENCY_UNSUPPORTED');
    const cart = await account.page.request.get('/api/cart');
    expect(cart.ok()).toBeTruthy();
    expect((await cart.json() as { items: { product: { id: string }; quantity: number }[] }).items).toMatchObject([{ product: { id: store.product.id }, quantity: 1 }]);
  } finally {
    await account.context.close();
    await prisma.cartItem.deleteMany({ where: { productId: store.product.id } });
  }
  expect(await prisma.cartItem.count({ where: { productId: store.product.id } })).toBe(0);
});

test('seller commission totals cover every currency and ledger entry independently of page size', async ({ browser }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({ where: { email: 'seller.local@example.test' }, select: { passwordHash: true } });
  const store = await fixtureSeller('ledger-total', sellerTemplate.passwordHash, suffix);
  const account = await openAccount(browser, store.user.email);
  const baseTime = new Date('2026-01-01T00:00:00.000Z');
  try {
    const parent = await prisma.parentOrder.create({ data: {
      orderNumber: `MV-LEDGER-${suffix}`, buyerEmail: 'ledger-buyer@example.test', buyerName: 'Ledger Buyer', addressJson: address,
      totalMinor: 20_000, currency: 'USD', status: 'CONFIRMED',
      sellerOrders: { create: { sellerId: store.seller.id, totalMinor: 20_000, status: 'CONFIRMED' } }
    }, include: { sellerOrders: true } });
    const sellerOrder = parent.sellerOrders[0]!;
    const usdAccrualIds = Array.from({ length: 102 }, (_, index) => `e2e-ledger-${suffix}-usd-accrual-${index}`);
    const accruals = [
      ...usdAccrualIds.map((id, index) => ({ id, sellerId: store.seller.id, sellerOrderId: sellerOrder.id, entryType: 'ACCRUAL' as const, amountMinor: 100, eligibleBaseMinor: 100, currency: 'USD', idempotencyKey: `${id}-key`, createdAt: new Date(baseTime.getTime() + index) })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `e2e-ledger-${suffix}-jpy-accrual-${index}`, sellerId: store.seller.id, sellerOrderId: sellerOrder.id, entryType: 'ACCRUAL' as const, amountMinor: 700, eligibleBaseMinor: 700, currency: 'JPY', idempotencyKey: `e2e-ledger-${suffix}-jpy-accrual-${index}-key`, createdAt: new Date(baseTime.getTime() + 102 + index) }))
    ];
    await prisma.sellerCommissionLedgerEntry.createMany({ data: accruals });
    await prisma.sellerCommissionLedgerEntry.createMany({ data: usdAccrualIds.slice(0, 100).map((reversalOfId, index) => ({
      id: `e2e-ledger-${suffix}-usd-reversal-${index}`, sellerId: store.seller.id, sellerOrderId: sellerOrder.id,
      entryType: 'REVERSAL' as const, amountMinor: -10, eligibleBaseMinor: 10, currency: 'USD',
      idempotencyKey: `e2e-ledger-${suffix}-usd-reversal-${index}-key`, reversalOfId,
      createdAt: new Date(baseTime.getTime() + 105 + index)
    })) });

    const fullSummaryResponse = await account.page.request.get('/api/seller/commissions?limit=200&offset=0');
    expect(fullSummaryResponse.ok(), await fullSummaryResponse.text()).toBeTruthy();
    const fullSummary = await fullSummaryResponse.json() as { entries: unknown[]; page: { limit: number; offset: number; hasMore: boolean }; totals: { currency: string; amountMinor: number }[] };
    expect(fullSummary.entries).toHaveLength(200);
    expect(fullSummary.page).toEqual({ limit: 200, offset: 0, hasMore: true });
    expect(fullSummary.totals).toEqual([{ currency: 'JPY', amountMinor: 2_100 }, { currency: 'USD', amountMinor: 9_200 }]);

    const smallerPageResponse = await account.page.request.get('/api/seller/commissions?limit=17&offset=50');
    expect(smallerPageResponse.ok(), await smallerPageResponse.text()).toBeTruthy();
    const smallerPage = await smallerPageResponse.json() as typeof fullSummary;
    expect(smallerPage.entries).toHaveLength(17);
    expect(smallerPage.page).toEqual({ limit: 17, offset: 50, hasMore: true });
    expect(smallerPage.totals).toEqual(fullSummary.totals);

    const finalPageResponse = await account.page.request.get('/api/seller/commissions?limit=200&offset=200');
    expect(finalPageResponse.ok(), await finalPageResponse.text()).toBeTruthy();
    const finalPage = await finalPageResponse.json() as typeof fullSummary;
    expect(finalPage.entries).toHaveLength(5);
    expect(finalPage.page.hasMore).toBe(false);
    expect(finalPage.totals).toEqual(fullSummary.totals);

    await account.page.goto('/seller/commissions');
    await expect(account.page.getByRole('heading', { name: 'Commission and adjustments' })).toBeVisible();
    await expect(account.page.getByText('Net ledger activity · USD')).toBeVisible();
    await expect(account.page.getByText('Net ledger activity · JPY')).toBeVisible();
    await expect(account.page.getByText('Reversed', { exact: true })).toHaveCount(100);
    await expect(account.page.getByText('Accrued', { exact: true })).toHaveCount(100);
    await expect(account.page.getByText('undefined', { exact: true })).toHaveCount(0);
  } finally {
    await account.context.close();
  }
});
