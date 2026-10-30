import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required for product action browser tests.');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const password = 'LocalDemoOnly-ChangeMe-123!';
const buyerEmail = 'buyer.local@example.test';
const messageMarker = `Product inquiry E2E ${randomUUID()}`;
const sellerEmail = 'seller.local@example.test';
let product: { id: string; name: string; storeSlug: string; sellerUserId: string };
let buyerId = '';
let hadFavorite = false;
let originalCartQuantity: number | null = null;
let cartId = '';
let messageId = '';
let sellerReplyMessageId = '';
let replyMessageId = '';
let conversationId = '';
let createdConversation = false;
const uploadedAssetIds: string[] = [];

test.beforeAll(async () => {
  const listing = await prisma.product.findFirstOrThrow({
    where: { status: 'APPROVED', seller: { is: { status: 'APPROVED', user: { is: { email: sellerEmail } } } }, inventory: { quantity: { gt: 0 } } },
    include: { seller: { include: { store: true } } },
    orderBy: { createdAt: 'asc' }
  });
  product = { id: listing.id, name: listing.name, storeSlug: listing.seller.store.slug, sellerUserId: listing.seller.userId };
  buyerId = (await prisma.user.findUniqueOrThrow({ where: { email: buyerEmail }, select: { id: true } })).id;
  hadFavorite = Boolean(await prisma.favorite.findUnique({ where: { userId_productId: { userId: buyerId, productId: product.id } } }));
  const cart = await prisma.cart.findUnique({ where: { userId: buyerId } });
  if (cart) {
    cartId = cart.id;
    originalCartQuantity = (await prisma.cartItem.findUnique({ where: { cartId_productId: { cartId, productId: product.id } }, select: { quantity: true } }))?.quantity ?? null;
  }
  const existingConversation = await prisma.conversation.findFirst({ where: { buyerId, sellerId: listing.sellerId!, productId: product.id, status: 'OPEN' }, select: { id: true } });
  createdConversation = !existingConversation;
});

test.afterAll(async () => {
  if (uploadedAssetIds.length) {
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: uploadedAssetIds } }, select: { id: true, storageKey: true, storageProvider: true } });
    const storageRoot = process.env.E2E_CONTENT_STORAGE_DIR ? path.resolve(process.env.E2E_CONTENT_STORAGE_DIR) : null;
    if (storageRoot) {
      for (const asset of assets) {
        if (asset.storageProvider !== 'LOCAL') continue;
        const filePath = path.resolve(storageRoot, asset.storageKey);
        if (!filePath.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Refusing E2E cleanup outside the disposable media directory.');
        await unlink(filePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    }
    await prisma.messageAttachment.deleteMany({ where: { mediaAssetId: { in: uploadedAssetIds }, messageId: null } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: uploadedAssetIds } } });
  }
  if (buyerId && product!) {
    if (hadFavorite) await prisma.favorite.upsert({ where: { userId_productId: { userId: buyerId, productId: product.id } }, update: {}, create: { userId: buyerId, productId: product.id } });
    else await prisma.favorite.deleteMany({ where: { userId: buyerId, productId: product.id } });
    if (cartId) {
      if (originalCartQuantity == null) await prisma.cartItem.deleteMany({ where: { cartId, productId: product.id } });
      else await prisma.cartItem.updateMany({ where: { cartId, productId: product.id }, data: { quantity: originalCartQuantity } });
    }
  }
  if (messageId || sellerReplyMessageId || replyMessageId) await prisma.message.deleteMany({ where: { id: { in: [messageId, sellerReplyMessageId, replyMessageId].filter(Boolean) } } });
  if (conversationId && createdConversation) await prisma.conversation.deleteMany({ where: { id: conversationId } });
  if (conversationId) {
    const notifications = await prisma.notification.findMany({ where: { eventType: 'NEW_PRODUCT_INQUIRY' }, select: { id: true, payloadJson: true } });
    const notificationIds = notifications.filter(item => typeof item.payloadJson === 'object' && item.payloadJson !== null && !Array.isArray(item.payloadJson) && item.payloadJson.conversationId === conversationId).map(item => item.id);
    if (notificationIds.length) await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
  }
  await prisma.$disconnect();
});

async function login(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: buyerEmail, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test('product cards share, save, buy now, and let members handle messages and notifications from the header', async ({ page, browser }) => {
  await login(page);
  await page.goto(`/store/${encodeURIComponent(product.storeSlug)}`);
  const card = page.locator('article.productCard').filter({ has: page.getByRole('heading', { name: product.name, exact: true }) }).first();
  await expect(card).toBeVisible();

  const likeButton = card.getByRole('button', { name: 'Like' });
  await likeButton.click();
  await expect(card.getByRole('button', { name: 'Loved' })).toHaveAttribute('aria-pressed', 'true');
  const saved = await page.request.get('/api/favorites/ids');
  expect((await saved.json() as { productIds: string[] }).productIds).toContain(product.id);
  const headerSummaryResponse = await page.request.get('/api/member/header-summary');
  expect(headerSummaryResponse.ok()).toBeTruthy();
  const headerSummary = await headerSummaryResponse.json() as { favoriteCount: number };
  expect(headerSummary.favoriteCount).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: 'Favorites' })).toHaveAttribute('aria-label', `Favorites, ${headerSummary.favoriteCount} saved`);

  await page.getByRole('link', { name: 'Favorites' }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  const favoriteCard = page.locator('article.favoriteProduct').filter({ has: page.getByRole('heading', { name: product.name, exact: true }) });
  await expect(favoriteCard).toBeVisible();
  await favoriteCard.getByRole('button', { name: 'Loved' }).click();
  await expect(page.getByText('No favorites yet')).toBeVisible();
  const removedFavorite = await page.request.get('/api/favorites/ids');
  expect((await removedFavorite.json() as { productIds: string[] }).productIds).not.toContain(product.id);

  await page.goto(`/store/${encodeURIComponent(product.storeSlug)}`);
  const refreshedCard = page.locator('article.productCard').filter({ has: page.getByRole('heading', { name: product.name, exact: true }) }).first();
  await expect(refreshedCard.getByRole('button', { name: 'Like' })).toBeVisible();
  await refreshedCard.getByRole('button', { name: 'Like' }).click();
  await expect(refreshedCard.getByRole('button', { name: 'Loved' })).toHaveAttribute('aria-pressed', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await refreshedCard.locator('.productShareMenu > summary').click();
  const shareMenu = page.getByRole('group', { name: `Share ${product.name}` });
  await expect(shareMenu).toBeVisible();
  const menuBounds = await shareMenu.boundingBox();
  const viewport = page.viewportSize();
  if (!menuBounds || !viewport) throw new Error('Share menu or browser viewport bounds are unavailable.');
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
  await expect(shareMenu.getByRole('link', { name: 'Facebook' })).toHaveAttribute('href', /facebook\.com\/sharer/);
  await expect(shareMenu.getByRole('link', { name: 'X \/ Twitter' })).toHaveAttribute('href', /twitter\.com\/intent\/tweet/);
  await expect(shareMenu.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', /wa\.me/);
  await expect(shareMenu.getByRole('button', { name: 'Copy product link' })).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await shareMenu.getByRole('button', { name: 'Copy product link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/products/${product.id}`);

  await card.getByRole('button', { name: 'Buy now' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  const savedCart = await page.request.get('/api/cart');
  expect((await savedCart.json() as { items: { productId: string }[] }).items.some(item => item.productId === product.id)).toBeTruthy();

  await page.goto(`/store/${encodeURIComponent(product.storeSlug)}`);
  const inquiryCard = page.locator('article.productCard').filter({ has: page.getByRole('heading', { name: product.name, exact: true }) }).first();
  await inquiryCard.getByRole('button', { name: 'Contact seller' }).click();
  await page.getByLabel('Message').fill(`${messageMarker}: Is this item still available?`);
  const sendResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/products/${product.id}/contact-seller` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message' }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status(), await sendResponse.text()).toBe(201);
  const sent = await sendResponse.json() as { conversationId: string; messageId: string };
  conversationId = sent.conversationId;
  messageId = sent.messageId;
  expect(await prisma.message.findUnique({ where: { id: messageId }, select: { body: true, senderId: true } })).toMatchObject({ body: `${messageMarker}: Is this item still available?`, senderId: buyerId });
  expect(await prisma.conversation.findUnique({ where: { id: conversationId }, select: { productId: true } })).toMatchObject({ productId: product.id });
  expect(await prisma.notification.findFirst({ where: { userId: product.sellerUserId, eventType: 'NEW_PRODUCT_INQUIRY' } })).toBeTruthy();
  await expect(page.getByText('Your message was sent to the seller.')).toBeVisible();

  const sellerPage = await browser.newPage();
  try {
    const sellerLogin = await sellerPage.request.post('/api/auth/login', { data: { email: sellerEmail, password } });
    expect(sellerLogin.ok(), await sellerLogin.text()).toBeTruthy();
    await sellerPage.goto('/');
    const sellerMessagesButton = sellerPage.getByRole('button', { name: /Messages/ });
    await expect(sellerMessagesButton.locator('.headerActivityBadge')).toBeVisible();
    await sellerMessagesButton.click();
    const sellerMessagesPopover = sellerPage.getByRole('region', { name: 'Messages' });
    const incomingMessage = sellerMessagesPopover.locator('.headerMessageItem').filter({ hasText: `${messageMarker}: Is this item still available?` });
    await expect(incomingMessage).toBeVisible();
    await incomingMessage.getByRole('button', { name: 'Reply' }).click();
    await incomingMessage.locator('textarea').fill(`${messageMarker}: Seller quick reply`);
    const sellerReplyResponsePromise = sellerPage.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/messages` && response.request().method() === 'POST');
    await incomingMessage.getByRole('button', { name: 'Send reply' }).click();
    const sellerReplyResponse = await sellerReplyResponsePromise;
    expect(sellerReplyResponse.status(), await sellerReplyResponse.text()).toBe(201);
    sellerReplyMessageId = (await sellerReplyResponse.json() as { id: string }).id;
    await expect(sellerMessagesButton.locator('.headerActivityBadge')).toHaveCount(0);

    const notificationsButton = sellerPage.getByRole('button', { name: /Notifications/ });
    await expect(notificationsButton.locator('.headerActivityBadge')).toBeVisible();
    await notificationsButton.click();
    const notificationPopover = sellerPage.getByRole('region', { name: 'Notifications' });
    const inquiryNotification = notificationPopover.locator('.headerNotificationItem').filter({ hasText: `A buyer sent you a message about ${product.name}.` });
    await expect(inquiryNotification).toBeVisible();
    await inquiryNotification.click();
    await expect(inquiryNotification).not.toHaveClass(/isUnread/);
    await expect(sellerPage).toHaveURL(/\/$/);
  } finally {
    await sellerPage.close();
  }

  await page.getByRole('button', { name: /Messages/ }).click();
  const inboxPopover = page.getByRole('region', { name: 'Messages' });
  const quickMessage = inboxPopover.locator('.headerMessageItem').filter({ hasText: `${messageMarker}: Seller quick reply` });
  await expect(quickMessage).toBeVisible();
  expect(await inboxPopover.locator('.headerMessageItem').count()).toBeLessThanOrEqual(10);
  await expect(page.getByRole('button', { name: /Messages/ }).locator('.headerActivityBadge')).toHaveCount(0);
  await quickMessage.getByRole('button', { name: 'Reply' }).click();
  await quickMessage.locator('textarea').fill(`${messageMarker}: Buyer quick reply`);
  const headerLoveReaction = quickMessage.getByRole('button', { name: /^Love/ });
  await headerLoveReaction.click();
  await expect(quickMessage.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'true');
  const headerFilePicker = quickMessage.locator('input[type="file"]');
  await headerFilePicker.setInputFiles([
    { name: 'header-preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQqHD7D8IMMAYAP6AHlTA6/JcAAAAASUVORK5CYII=', 'base64') },
    { name: 'header-clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local video preview only') }
  ]);
  await expect(quickMessage.locator('.headerMessageDrafts img')).toHaveCount(1);
  await expect(quickMessage.locator('.headerMessageDrafts video')).toHaveCount(1);
  expect(await quickMessage.locator('.headerMessageDrafts video').evaluate(element => (element as HTMLVideoElement).autoplay)).toBe(false);
  await quickMessage.getByRole('button', { name: 'Remove header-clip.mp4' }).click();
  const headerUploadResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/attachments` && response.request().method() === 'POST');
  const quickReplyResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/messages` && response.request().method() === 'POST');
  await quickMessage.getByRole('button', { name: 'Send reply' }).click();
  const headerUploadResponse = await headerUploadResponsePromise;
  expect([201, 202], await headerUploadResponse.text()).toContain(headerUploadResponse.status());
  const headerUpload = await headerUploadResponse.json() as { assetId: string; scanStatus: string };
  uploadedAssetIds.push(headerUpload.assetId);
  const quickReplyResponse = await quickReplyResponsePromise;
  expect(quickReplyResponse.status(), await quickReplyResponse.text()).toBe(201);
  replyMessageId = (await quickReplyResponse.json() as { id: string }).id;
  await expect(inboxPopover.getByText(`${messageMarker}: Buyer quick reply`)).toBeVisible();
  await expect(quickMessage.getByText(/header-preview\.png is private because the malware scanner is unavailable/)).toBeVisible();
  await quickMessage.getByRole('button', { name: 'Retry safety scan' }).click();
  await expect(quickMessage.getByText(/header-preview\.png is private because the malware scanner is unavailable/)).toBeVisible();
  await inboxPopover.getByRole('link', { name: 'View all messages' }).click();
  const conversationButton = page.locator(`.messagesConversationButton[data-conversation-id="${conversationId}"]`);
  await expect(conversationButton).toBeVisible();
  await conversationButton.click();
  await expect(page.locator('.messagesProductContext')).toContainText('Regarding this listing');
  await expect(page.locator('.messagesProductContext')).toContainText(product.name);
  const messageBubble = page.locator('.messageBubble').filter({ hasText: messageMarker });
  const loveReaction = messageBubble.getByRole('button', { name: /^Love/ });
  await loveReaction.click();
  await expect(messageBubble.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'true');

  const filePicker = page.locator('.messagesComposer input[type="file"]');
  await filePicker.setInputFiles([
    { name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQqHD7D8IMMAYAP6AHlTA6/JcAAAAASUVORK5CYII=', 'base64') },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local video preview only') }
  ]);
  await expect(page.locator('.messageDrafts img')).toHaveCount(1);
  await expect(page.locator('.messageDrafts video')).toHaveCount(1);
  expect(await page.locator('.messageDrafts video').evaluate(element => (element as HTMLVideoElement).autoplay)).toBe(false);

  const csrfToken = await page.evaluate(() => document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1] ?? '');
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPQqHD7D8IMMAYAP6AHlTA6/JcAAAAASUVORK5CYII=', 'base64');
  const stagedUpload = await page.request.post(`/api/conversations/${conversationId}/attachments`, {
    data: pngBytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'safety-check.png', 'X-File-Type': 'image/png', 'x-csrf-token': csrfToken }
  });
  const stagedBody = await stagedUpload.text();
  if (![201, 202].includes(stagedUpload.status())) throw new Error(`Private message upload failed (${stagedUpload.status()}): ${stagedBody}`);
  const staged = JSON.parse(stagedBody) as { id: string; assetId: string; scanStatus: string };
  uploadedAssetIds.push(staged.assetId);
  expect(staged.scanStatus).toBe('QUARANTINED');
  const stagedMediaAccess = await page.request.get(`/api/conversations/${conversationId}/attachments/${staged.assetId}`);
  expect(stagedMediaAccess.status()).toBe(404);
  const discardUpload = await page.request.delete(`/api/conversations/${conversationId}/attachments/${staged.id}`, { headers: { 'x-csrf-token': csrfToken } });
  expect(discardUpload.status()).toBe(204);
});
