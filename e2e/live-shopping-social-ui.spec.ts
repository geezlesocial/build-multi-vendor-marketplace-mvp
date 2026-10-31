import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const sessionId = 'live-social-ui-test';
const screenshotDirectory = process.env.LIVE_SHOPPING_SCREENSHOT_DIR;

async function capture(page: Page, filename: string) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, filename), fullPage: true });
}

test('live watch supports reactions, share/embed, repost, and shoppable product actions without closing playback', async ({ page }) => {
  const reactions = { LIKE: 0, LOVE: 0, HAPPY: 0, CONGRATS: 0, SMILE: 0 };
  const sessionProducts = [{ productId: 'product-1', featured: false, shopFeatured: true, shopSortOrder: 0, shopPinned: true, product: { id: 'product-1', name: 'Canvas Tote', description: 'A sturdy everyday tote.', priceMinor: 2400, salePriceMinor: null, currency: 'USD', availableStock: 8 } }];
  let myReaction: keyof typeof reactions | null = null;
  let reposted = false;
  let repostCount = 0;
  let cartAdded = false;
  const cartProduct = { id: 'product-1', name: 'Canvas Tote', description: 'A sturdy everyday tote.', priceMinor: 2400, salePriceMinor: null, currency: 'USD', availableStock: 8, inventory: { quantity: 8 }, sellerId: 'seller-1', productType: { id: 'physical', name: 'Physical product', requiresShipping: false } };

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (pathname === '/api/auth/me') return json({ user: { id: 'buyer-1', email: 'buyer@example.test', name: 'Live Buyer', role: 'BUYER', emailVerifiedAt: '2026-10-30T00:00:00.000Z', onboardingCompletedAt: '2026-10-30T00:00:00.000Z' } });
    if (pathname === '/api/platform/branding') return json({ platformName: 'Market Lane', shortName: 'Market Lane', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null });
    if (pathname === '/api/settings/public') return json({ multiVendorEnabled: true, paymentMethods: [{ method: 'STRIPE', enabled: true }], liveShopping: { enabled: false, deploymentGate: false, reason: 'Provider not configured for this test.' } });
    if (pathname === '/api/products') return json({ items: [] });
    if (pathname === '/api/cart') return json({ items: cartAdded ? [{ product: cartProduct, quantity: 1 }] : [] });
    if (pathname === '/api/currency/cart-options') return json({ checkoutCurrency: 'USD', displayCurrencies: [], paymentCurrencies: [], checkoutCompatible: true });
    if (pathname === '/api/account/preferences') return json({ preference: { displayCurrency: 'USD' } });
    if (pathname === '/api/member/header-summary') return json({ favoriteCount: 0, unreadNotificationCount: 0, unreadMessageCount: 0, notifications: [], messages: [] });
    if (pathname === '/api/ai/status') return json({ enabled: false });
    if (pathname === `/api/live-sessions/${sessionId}` && method === 'GET') return json({
      id: sessionId, title: 'Live Social Commerce Demo', description: 'Watch, react, and shop without leaving the stream.', status: 'LIVE', realtimeAvailable: true, playbackAvailable: true,
      seller: { store: { name: 'Demo Store', slug: 'demo-store' } },
      products: sessionProducts
    });
    if (pathname === `/api/live-sessions/${sessionId}/token`) return json({ error: 'Synthetic provider unavailable for this interface test.' }, 409);
    if (pathname === `/api/live-sessions/${sessionId}/engagement/events`) return json({ error: 'Event stream intentionally disabled for this UI test.' }, 503);
    if (pathname === `/api/live-sessions/${sessionId}/engagement`) return json({ viewCount: 42, viewersNow: 3, reactions, myReaction });
    if (pathname === `/api/live-sessions/${sessionId}/reaction` && method === 'PUT') {
      const body = request.postDataJSON() as { reaction: keyof typeof reactions | null };
      myReaction = body.reaction;
      if (myReaction) reactions[myReaction] += 1;
      return json({ viewCount: 42, viewersNow: 3, reactions, myReaction });
    }
    if (pathname === `/api/live-sessions/${sessionId}/social` && method === 'GET') return json({ repostCount, reposted });
    if (pathname === `/api/live-sessions/${sessionId}/repost` && method === 'POST') { reposted = true; repostCount += 1; return json({ reposted, repostCount }); }
    if (pathname === `/api/live-sessions/${sessionId}/repost` && method === 'DELETE') { reposted = false; repostCount = Math.max(0, repostCount - 1); return json({ reposted, repostCount }); }
    if (pathname === `/api/live-sessions/${sessionId}/products/product-1`) return json({
      id: 'product-1', name: 'Canvas Tote', description: 'A sturdy everyday tote.', priceMinor: 2400, salePriceMinor: null, currency: 'USD', availableStock: 8,
      wholesaleEnabled: false, wholesaleMinQuantity: null, wholesaleMaxQuantity: null, images: [], variants: [], productType: { name: 'Physical product', requiresShipping: true }
    });
    if (pathname === '/api/orders/checkout' && method === 'POST') return json({ payment: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_live_embed' } }, 201);
    if (pathname === '/api/cart/items' && method === 'POST') { cartAdded = true; return json({ id: 'cart-item-1' }, 201); }
    return json({});
  });

  await page.goto(`/live/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'Live Social Commerce Demo' })).toBeVisible();
  await capture(page, '01-live-viewer.png');
  sessionProducts.push({ productId: 'product-2', featured: false, shopFeatured: true, shopSortOrder: 1, shopPinned: false, product: { id: 'product-2', name: 'Freshly tagged item', description: 'Added during the show.', priceMinor: 1800, salePriceMinor: null, currency: 'USD', availableStock: 4 } });
  await expect(page.getByRole('button', { name: /Freshly tagged item/ })).toBeVisible({ timeout: 15_000 });

  for (const reaction of ['Like', 'Love', 'Happy', 'Smile']) {
    const button = page.getByRole('button', { name: new RegExp(`^${reaction},`) });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }

  await page.getByText('Share', { exact: true }).click();
  await capture(page, '02-share-menu.png');
  for (const [label, host] of [['Facebook', 'facebook.com'], ['WhatsApp', 'wa.me'], ['LinkedIn', 'linkedin.com'], ['X / Twitter', 'twitter.com']] as const) {
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', new RegExp(host));
  }
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Live link copied.' })).toBeVisible();
  await page.getByRole('button', { name: 'Embed video' }).click();
  const embedDialog = page.getByRole('dialog', { name: 'Embed video' });
  await expect(embedDialog).toBeVisible();
  const embedCode = await embedDialog.getByRole('textbox', { name: 'Embed code' }).inputValue();
  expect(embedCode).toContain(`/live/${sessionId}/embed`);
  expect(embedCode).not.toContain('token');
  await embedDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /^Repost/ }).click();
  await expect(page.getByRole('button', { name: /^Reposted/ })).toHaveAttribute('aria-pressed', 'true');
  await capture(page, '03-reposted-live.png');
  await page.getByRole('button', { name: /^Reposted/ }).click();
  await expect(page.getByRole('button', { name: /^Repost/ })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: /Canvas Tote/ }).click();
  const productDialog = page.getByRole('dialog', { name: 'Canvas Tote' });
  await expect(productDialog).toBeVisible();
  await capture(page, '04-shoppable-product-popup.png');
  await productDialog.getByRole('button', { name: 'Add to cart' }).click();
  await expect(productDialog.getByRole('status').filter({ hasText: 'Added to your cart.' })).toBeVisible();
  await capture(page, '05-added-to-cart.png');
  await expect(page.getByRole('heading', { name: 'Live Social Commerce Demo' })).toBeVisible();

  await productDialog.getByRole('button', { name: 'Buy now' }).click();
  const checkoutDialog = page.getByRole('dialog', { name: 'Complete your order' });
  await expect(checkoutDialog).toBeVisible();
  const checkoutFrame = page.frameLocator('iframe[title="Secure checkout while watching live shopping"]');
  await expect(checkoutFrame.getByRole('heading', { name: 'Complete your order' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live Social Commerce Demo' })).toBeVisible();
  await capture(page, '06-secure-checkout-keeps-live-open.png');
  await checkoutFrame.getByLabel('Name').fill('Live Buyer');
  await checkoutFrame.getByLabel('Email').fill('buyer@example.test');
  await checkoutFrame.getByLabel('Address').fill('1 Test Street');
  await checkoutFrame.getByLabel('City').fill('Test City');
  await checkoutFrame.getByLabel('Region').fill('TS');
  await checkoutFrame.getByLabel('Postal code').fill('1000');
  await checkoutFrame.getByLabel('Country code').fill('US');
  await checkoutFrame.getByLabel('Payment method').selectOption('STRIPE');
  await checkoutFrame.getByRole('button', { name: 'Place order' }).click();
  const providerLink = checkoutFrame.getByRole('link', { name: 'Continue to secure payment' });
  await expect(providerLink).toHaveAttribute('href', 'https://checkout.stripe.com/c/pay/cs_test_live_embed');
  await expect(providerLink).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('heading', { name: 'Live Social Commerce Demo' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  const checkoutBox = await checkoutDialog.boundingBox();
  expect(checkoutBox).not.toBeNull();
  expect(checkoutBox!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await checkoutDialog.getByRole('button', { name: 'Back to product' }).click();
  await expect(page.getByRole('dialog', { name: 'Canvas Tote' })).toBeVisible();

  const box = await productDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await capture(page, '07-mobile-live-viewer.png');
});

test('buyer profile timeline shows only their live reposts and supports unrepost', async ({ page }) => {
  let reposted = true;
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/auth/me') return json({ user: { id: 'buyer-1', email: 'buyer@example.test', name: 'Live Buyer', role: 'BUYER', emailVerifiedAt: '2026-10-30T00:00:00.000Z', onboardingCompletedAt: '2026-10-30T00:00:00.000Z' } });
    if (pathname === '/api/platform/branding') return json({ platformName: 'Market Lane', shortName: 'Market Lane', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null });
    if (pathname === '/api/cart') return json({ items: [] });
    if (pathname === '/api/member/header-summary') return json({ favoriteCount: 0, unreadNotificationCount: 0, unreadMessageCount: 0, notifications: [], messages: [] });
    if (pathname === '/api/dashboard/access') return json({ buyer: true, seller: false, affiliateEligible: false, sellerApplication: null });
    if (pathname === '/api/dashboard/buyer') return json({ orders: [], cart: { items: [] }, favorites: [], conversations: [], notifications: [], addresses: [], affiliate: null });
    if (pathname === '/api/account/live-reposts') return json(reposted ? [{ repostedAt: '2026-10-30T00:00:00.000Z', session: { id: sessionId, title: 'Reposted live show', status: 'LIVE', seller: { store: { name: 'Demo Store', slug: 'demo-store' } }, products: [] } }] : []);
    if (pathname === `/api/live-sessions/${sessionId}/repost` && method === 'DELETE') { reposted = false; return json({ reposted: false, repostCount: 0 }); }
    return json({});
  });
  await page.goto('/dashboard?tab=profile');
  await expect(page.getByRole('heading', { name: 'Live shows you reposted' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reposted live show' })).toBeVisible();
  await capture(page, '08-profile-repost-timeline.png');
  await page.getByRole('button', { name: 'Unrepost' }).click();
  await expect(page.getByText('Your reposted live shows will appear here.')).toBeVisible();
});

test('seller product picker searches product names and previews image, price, stock, and six-item limit', async ({ page }) => {
  const products = Array.from({ length: 7 }, (_, index) => ({
    id: `product-${index + 1}`,
    name: index === 0 ? 'Canvas Tote' : `Demo product ${index + 1}`,
    description: 'Approved seller listing', priceMinor: 2400 + index * 100, salePriceMinor: null, currency: 'USD',
    status: 'APPROVED', images: [{ id: `image-${index + 1}`, url: '/test-product.png', alt: 'Product preview' }],
    inventory: { quantity: 8 - index }
  }));
  await page.route('**/test-product.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="12" fill="#dcebe0"/><path d="M20 56h40L52 30H28z" fill="#315d48"/></svg>' }));
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/auth/me') return json({ user: { id: 'seller-user', email: 'seller@example.test', name: 'Live Seller', role: 'SELLER', sellerId: 'seller-1', emailVerifiedAt: '2026-10-30T00:00:00.000Z', onboardingCompletedAt: '2026-10-30T00:00:00.000Z' } });
    if (pathname === '/api/platform/branding') return json({ platformName: 'Market Lane', shortName: 'Market Lane', logoMediaId: null, alternateLogoMediaId: null, faviconMediaId: null, defaultAvatarMediaId: null });
    if (pathname === '/api/cart') return json({ items: [] });
    if (pathname === '/api/member/header-summary') return json({ favoriteCount: 0, unreadNotificationCount: 0, unreadMessageCount: 0, notifications: [], messages: [] });
    if (pathname === '/api/dashboard/access') return json({ buyer: true, seller: true, affiliateEligible: false, sellerApplication: { status: 'APPROVED', store: { name: 'Demo Store', slug: 'demo-store' } } });
    if (pathname === '/api/dashboard/seller') return json({ store: { id: 'store-1', name: 'Demo Store', slug: 'demo-store' }, summary: { orderCount: 0, grossByCurrency: [] }, products, orders: [], conversations: [], payoutMethods: [], payouts: [], live: { effectiveEnabled: false, deploymentGate: false, reason: 'Provider is not configured.' } });
    if (pathname === '/api/seller/live-sessions' || pathname === '/api/seller/live-sessions?view=deleted') return json([]);
    if (pathname === '/api/live-shopping/status') return json({ effectiveEnabled: false, deploymentGate: false, runtimeEnabled: false, reason: 'Provider is not configured.', readiness: { provider: null, configured: false, healthy: false, attendanceVerificationAvailable: false, reason: 'Provider is not configured.' } });
    return json({});
  });
  await page.goto('/dashboard?mode=seller&tab=live');
  await expect(page.getByRole('heading', { name: 'Live shows' })).toBeVisible();
  const picker = page.locator('.liveProductTagPicker');
  await expect(picker.getByText('Canvas Tote')).toBeVisible();
  await expect(picker.getByText('$24.00')).toBeVisible();
  await expect(picker.getByText('8 available')).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search your products' }).fill('canvas');
  await expect(picker.getByText('Demo product 2')).toHaveCount(0);
  await picker.getByRole('searchbox', { name: 'Search your products' }).clear();
  for (let index = 1; index <= 6; index += 1) await picker.getByRole('checkbox', { name: `Feature ${products[index - 1]!.name}` }).check();
  await expect(picker.getByText('Featured products · 6/6')).toBeVisible();
  const seventhProduct = picker.getByRole('checkbox', { name: 'Feature Demo product 7' });
  await seventhProduct.click();
  await expect(seventhProduct).not.toBeChecked();
  await expect(picker.getByRole('status').filter({ hasText: 'up to six products' })).toBeVisible();
  await capture(page, '09-seller-product-picker.png');
});
