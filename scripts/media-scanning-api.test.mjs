import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
const database = validateE2EDatabaseURL(databaseUrl);
const runIdentity = process.env.WALLET_FUNDING_SANDBOX_ID;
if (!runIdentity || process.env.DATABASE_URL !== databaseUrl || !database.databaseName.toLowerCase().includes(runIdentity.toLowerCase())) {
  throw new Error('Media scanning API tests require the unique per-run E2E database to be the only configured database target.');
}

const [
  { prisma, tokenHash }, { registerAvatarRoutes }, { registerStoreMediaRoutes }, { registerBrandingMediaRoutes },
  { registerContentRoutes }, { registerProductMediaRoutes }, { registerStoreContentRoutes }, { registerPlatformRoutes },
  { scanQuarantinedMedia, MediaScannerError, ClamAvScanner },
  { env }, { Role, SellerStatus, MediaKind, MediaPurpose, MediaScanStatus, MediaUploadStatus, Prisma }, sharpModule
] = await Promise.all([
  import('../apps/api/src/security.ts'), import('../apps/api/src/avatar-routes.ts'),
  import('../apps/api/src/store-media-routes.ts'), import('../apps/api/src/branding-media-routes.ts'),
  import('../apps/api/src/content-routes.ts'), import('../apps/api/src/product-media-routes.ts'),
  import('../apps/api/src/store-content-routes.ts'), import('../apps/api/src/platform-routes.ts'),
  import('../apps/api/src/media-scanner.ts'), import('../apps/api/src/config.ts'), import('@prisma/client'), import('sharp')
]);

class PrivateTestStorage {
  objects = new Map();
  async createUploadForm(key, contentType, maxBytes) {
    return { url: 'http://object-storage.test.invalid/upload', fields: { key, 'Content-Type': contentType, maxBytes: String(maxBytes) } };
  }
  async head(key) {
    const object = this.objects.get(key);
    if (!object) throw new Error('Synthetic object not found');
    return { ContentLength: object.bytes.length, ContentType: object.contentType };
  }
  async readLimited(key, maxBytes) {
    const object = this.objects.get(key);
    if (!object) throw new Error('Synthetic object not found');
    if (object.bytes.length > maxBytes) throw new Error('Synthetic object exceeds byte limit');
    return { bytes: object.bytes, contentLength: object.bytes.length, contentType: object.contentType };
  }
  async put(key, bytes, contentType) { this.objects.set(key, { bytes: Buffer.from(bytes), contentType }); }
  open(key) { const object = this.objects.get(key); return object ? Readable.from(object.bytes) : Readable.from([]); }
  async remove(key) { this.objects.delete(key); }
}

class FixtureScanner {
  outcomes = [];
  calls = 0;
  async scan() {
    this.calls += 1;
    const result = this.outcomes.shift() ?? 'CLEAN';
    if (result instanceof Error) throw result;
    return result;
  }
}

async function png() {
  return sharpModule.default({ create: { width: 3, height: 2, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 1 } } }).png().toBuffer();
}

test('private uploads validate, scan idempotently, fail closed, and preserve approved replacements', async t => {
  const admin = await prisma.user.findUnique({ where: { email: 'admin.local@example.test' } });
  const buyer = await prisma.user.findUnique({ where: { email: 'buyer.local@example.test' } });
  const seller = await prisma.user.findUnique({ where: { email: 'seller.local@example.test' }, include: { seller: { include: { store: true } } } });
  assert.ok(admin && buyer && seller?.seller?.store, 'local seeded admin, buyer, and seller/store are required');

  const previousAvatarId = buyer.avatarMediaId;
  const previousStore = seller.seller.store;
  const mediaIds = [];
  const sessionIds = [];
  const users = new Map([['admin', admin], ['buyer', buyer], ['seller', seller]]);
  const auth = new Map();
  const storage = new PrivateTestStorage();
  const scanner = new FixtureScanner();
  let server;

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.cookies?.marketplace_csrf || req.cookies.marketplace_csrf !== req.get('x-csrf-token')) return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  });
  registerContentRoutes(app, (_provider, key) => storage.open(key), storage, scanner);
  registerPlatformRoutes(app);
  registerStoreContentRoutes(app);
  registerAvatarRoutes(app, storage, scanner);
  registerStoreMediaRoutes(app, storage, scanner);
  registerBrandingMediaRoutes(app, storage, scanner);
  registerProductMediaRoutes(app);
  app.use((error, _req, res, _next) => {
    const status = error.statusCode ?? 500;
    return res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message, ...(error.code ? { code: error.code } : {}) });
  });

  for (const [key, user] of users) {
    const raw = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    const session = await prisma.session.create({ data: { tokenHash: tokenHash(raw), userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    sessionIds.push(session.id);
    auth.set(key, { cookie: `${env.SESSION_COOKIE_NAME}=${raw}; marketplace_csrf=${csrf}`, csrf });
  }
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await prisma.user.update({ where: { id: buyer.id }, data: { avatarMediaId: previousAvatarId } });
    await prisma.store.update({ where: { id: previousStore.id }, data: {
      themeDraftJson: previousStore.themeDraftJson ?? Prisma.DbNull,
      themePublishedJson: previousStore.themePublishedJson ?? Prisma.DbNull,
      themePublishedAt: previousStore.themePublishedAt
    } });
    if (mediaIds.length) await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaIds } } });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  async function call(who, method, url, body) {
    const identity = auth.get(who);
    return fetch(`${base}${url}`, {
      method,
      headers: { Cookie: identity.cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': identity.csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const validPng = await png();

  const badType = await call('buyer', 'POST', '/api/account/avatar/uploads', { fileName: 'avatar.svg', contentType: 'image/svg+xml', sizeBytes: 100 });
  assert.equal(badType.status, 415, 'unsupported active image formats are rejected before storage');
  const tooLarge = await call('buyer', 'POST', '/api/account/avatar/uploads', { fileName: 'avatar.png', contentType: 'image/png', sizeBytes: env.CONTENT_MAX_IMAGE_BYTES + 1 });
  assert.equal(tooLarge.status, 413, 'oversized reservation is rejected before upload');

  async function reserveUpload(who, url, fileName, contentType, bytes) {
    const reservationResponse = await call(who, 'POST', url, { fileName, contentType, sizeBytes: bytes.length });
    assert.equal(reservationResponse.status, 201, `expected reservation: ${await reservationResponse.clone().text()}`);
    const reservation = await reservationResponse.json();
    mediaIds.push(reservation.id);
    storage.objects.set(reservation.upload.fields.key, { bytes: Buffer.from(bytes), contentType });
    return reservation;
  }

  const firstAvatar = await reserveUpload('buyer', '/api/account/avatar/uploads', 'profile.png', 'image/png', validPng);
  const strangerFinalize = await call('admin', 'POST', `/api/account/avatar/${firstAvatar.id}/finalize`, {});
  assert.equal(strangerFinalize.status, 404, 'a different signed-in user cannot finalize another user’s reservation');
  scanner.outcomes.push('CLEAN');
  const cleanFinalize = await call('buyer', 'POST', `/api/account/avatar/${firstAvatar.id}/finalize`, {});
  assert.equal(cleanFinalize.status, 201, `clean scan succeeds: ${await cleanFinalize.clone().text()}`);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).avatarMediaId, firstAvatar.id, 'only a clean scan activates the new avatar');
  const infectedAvatar = await reserveUpload('buyer', '/api/account/avatar/uploads', 'infected.png', 'image/png', validPng);
  scanner.outcomes.push('INFECTED');
  const infectedFinalize = await call('buyer', 'POST', `/api/account/avatar/${infectedAvatar.id}/finalize`, {});
  assert.equal(infectedFinalize.status, 202);
  assert.equal((await infectedFinalize.json()).scanStatus, MediaScanStatus.REJECTED);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).avatarMediaId, firstAvatar.id, 'infected replacement cannot displace the approved avatar');
  assert.equal((await call('buyer', 'GET', `/content-media/${infectedAvatar.id}`)).status, 404, 'rejected media is never publicly delivered');
  assert.equal((await call('buyer', 'GET', '/api/account/avatar')).status, 200, 'the existing approved avatar remains available');

  const malformed = await reserveUpload('buyer', '/api/account/avatar/uploads', 'malformed.png', 'image/png', Buffer.from('not an image'));
  const malformedFinalize = await call('buyer', 'POST', `/api/account/avatar/${malformed.id}/finalize`, {});
  assert.equal(malformedFinalize.status, 415, 'declared MIME and extension do not bypass image decoding/signature checks');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).avatarMediaId, firstAvatar.id);

  const transientAvatar = await reserveUpload('buyer', '/api/account/avatar/uploads', 'retry.png', 'image/png', validPng);
  scanner.outcomes.push(new MediaScannerError('SCANNER_UNAVAILABLE', 'synthetic scanner outage'));
  const outageFinalize = await call('buyer', 'POST', `/api/account/avatar/${transientAvatar.id}/finalize`, {});
  assert.equal(outageFinalize.status, 202);
  const outageResult = await outageFinalize.json();
  assert.equal(outageResult.scanStatus, MediaScanStatus.QUARANTINED);
  assert.equal(outageResult.scanErrorCode, 'SCANNER_UNAVAILABLE');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).avatarMediaId, firstAvatar.id, 'scanner outage preserves the prior approved avatar');
  scanner.outcomes.push('CLEAN');
  const retried = await call('buyer', 'POST', `/api/account/avatar/${transientAvatar.id}/scan-retry`, {});
  assert.equal((await retried.json()).scanStatus, MediaScanStatus.APPROVED, 'a safe retry can approve after the scanner recovers');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).avatarMediaId, transientAvatar.id);

  const contentUpload = await reserveUpload('admin', '/api/admin/content/media/uploads', 'article.png', 'image/png', validPng);
  scanner.outcomes.push('CLEAN');
  const contentFinalize = await call('admin', 'POST', `/api/admin/content/media/${contentUpload.id}/finalize`, {});
  assert.equal(contentFinalize.status, 200, `CMS asset is scanned before use: ${await contentFinalize.clone().text()}`);
  const contentAsset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: contentUpload.id } });
  assert.equal(contentAsset.purpose, MediaPurpose.PLATFORM_CONTENT);
  assert.equal(contentAsset.scanStatus, MediaScanStatus.APPROVED);
  const callCountAfterClean = scanner.calls;
  const duplicateFinalize = await call('admin', 'POST', `/api/admin/content/media/${contentUpload.id}/finalize`, {});
  assert.equal(duplicateFinalize.status, 200, 'duplicate CMS finalize returns its saved result');
  assert.equal(scanner.calls, callCountAfterClean, 'duplicate finalize does not repeat a completed scan');
  assert.equal((await call('buyer', 'GET', `/content-media/${contentUpload.id}`)).status, 404, 'clean but unreferenced draft media is not publicly delivered');

  const oldStoreImageId = crypto.randomUUID();
  const oldStoreImageKey = `stores/${seller.seller.store.id}/media/${oldStoreImageId}.webp`;
  const oldStoreImageBytes = await sharpModule.default(validPng).webp().toBuffer();
  await prisma.mediaAsset.create({ data: {
    id: oldStoreImageId, storageKey: oldStoreImageKey, originalName: 'previous-approved.webp', safeName: 'previous-approved.webp',
    kind: MediaKind.IMAGE, detectedMime: 'image/webp', sizeBytes: oldStoreImageBytes.length,
    checksum: crypto.createHash('sha256').update(oldStoreImageBytes).digest('hex'), uploaderId: seller.id,
    storeId: seller.seller.store.id, purpose: MediaPurpose.STORE_MEDIA, storageProvider: 'OBJECT',
    uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED
  } });
  mediaIds.push(oldStoreImageId);
  storage.objects.set(oldStoreImageKey, { bytes: oldStoreImageBytes, contentType: 'image/webp' });
  const themeResponse = await call('seller', 'GET', '/api/seller/store-theme');
  assert.equal(themeResponse.status, 200);
  const theme = (await themeResponse.json()).draft;
  const savePrior = await call('seller', 'PUT', '/api/seller/store-theme', { ...theme, logoMediaId: oldStoreImageId, faviconMediaId: oldStoreImageId });
  assert.equal(savePrior.status, 200);
  assert.equal((await call('seller', 'POST', '/api/seller/store-theme/publish', {})).status, 200);
  const storeReplacement = await reserveUpload('seller', '/api/seller/store-media/uploads', 'infected-store.png', 'image/png', validPng);
  scanner.outcomes.push('INFECTED');
  const storeFinalize = await call('seller', 'POST', `/api/seller/store-media/${storeReplacement.id}/finalize`, {});
  assert.equal(storeFinalize.status, 202);
  assert.equal((await storeFinalize.json()).scanStatus, MediaScanStatus.REJECTED);
  const publicThemeResponse = await call('buyer', 'GET', `/api/stores/${seller.seller.store.slug}/theme`);
  assert.equal((await publicThemeResponse.json()).theme.logoMediaId, oldStoreImageId, 'rejected replacement leaves the prior approved Store image published');
  assert.equal((await call('buyer', 'GET', `/content-media/${oldStoreImageId}`)).status, 200);
  assert.equal((await call('buyer', 'GET', `/content-media/${storeReplacement.id}`)).status, 404);

  // A missing scanner is distinct from a scanner error and never grants approval.
  const noScannerId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: {
    id: noScannerId, storageKey: `test-private/${noScannerId}.png`, originalName: 'scanner-unavailable.png', safeName: 'scanner-unavailable.png',
    kind: MediaKind.IMAGE, detectedMime: 'image/png', sizeBytes: validPng.length,
    checksum: crypto.createHash('sha256').update(validPng).digest('hex'), uploaderId: admin.id,
    purpose: MediaPurpose.PLATFORM_CONTENT, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED
  } });
  mediaIds.push(noScannerId);
  const missingScanner = await scanQuarantinedMedia({ assetId: noScannerId, bytes: validPng, scanner: null });
  assert.equal(missingScanner.scanStatus, MediaScanStatus.QUARANTINED);
  assert.equal(missingScanner.scanErrorCode, 'SCANNER_UNAVAILABLE');

  if (process.env.STAGING_TEST_CLAMAV_HOST) {
    const realScanId = crypto.randomUUID();
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii');
    const key = `test-private/${realScanId}.txt`;
    await prisma.mediaAsset.create({ data: {
      id: realScanId, storageKey: key, originalName: 'harmless-antivirus-test-fixture.txt', safeName: 'harmless-antivirus-test-fixture.txt',
      kind: MediaKind.DOCUMENT, detectedMime: 'text/plain', sizeBytes: eicar.length,
      checksum: crypto.createHash('sha256').update(eicar).digest('hex'), uploaderId: admin.id,
      purpose: MediaPurpose.PLATFORM_CONTENT, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE,
      scanStatus: MediaScanStatus.QUARANTINED
    } });
    mediaIds.push(realScanId);
    storage.objects.set(key, { bytes: eicar, contentType: 'text/plain' });
    assert.equal((await call('buyer', 'GET', `/content-media/${realScanId}`)).status, 404, 'unscanned test media must remain inaccessible');
    const realScanner = new ClamAvScanner(process.env.STAGING_TEST_CLAMAV_HOST, Number(process.env.STAGING_TEST_CLAMAV_PORT ?? 13310), 15_000);
    const realVerdict = await scanQuarantinedMedia({ assetId: realScanId, bytes: eicar, scanner: realScanner, actorId: admin.id });
    assert.equal(realVerdict.scanStatus, MediaScanStatus.REJECTED, 'actual ClamAV infection verdict must persist as rejected media');
    assert.equal(realVerdict.scanErrorCode, 'MALWARE_DETECTED');
    assert.equal((await call('buyer', 'GET', `/content-media/${realScanId}`)).status, 404, 'infected media must remain inaccessible after the real scan');
  }

  // Exercise the stale-attempt compare-and-set with deterministic barriers: the
  // newer clean result completes first, then a late infected result must not win.
  const raceId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: {
    id: raceId, storageKey: `test-private/${raceId}.png`, originalName: 'duplicate-result.png', safeName: 'duplicate-result.png',
    kind: MediaKind.IMAGE, detectedMime: 'image/png', sizeBytes: validPng.length,
    checksum: crypto.createHash('sha256').update(validPng).digest('hex'), uploaderId: admin.id,
    purpose: MediaPurpose.PLATFORM_CONTENT, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED
  } });
  mediaIds.push(raceId);
  const calls = [];
  const waiters = [];
  const deferredScanner = { provider: 'test-fixture', scan: () => new Promise(resolve => { calls.push(resolve); waiters.splice(0).forEach(wake => wake()); }) };
  const waitForCalls = async count => { while (calls.length < count) await new Promise(resolve => waiters.push(resolve)); };
  const olderAttempt = scanQuarantinedMedia({ assetId: raceId, bytes: validPng, scanner: deferredScanner });
  await waitForCalls(1);
  await prisma.mediaAsset.update({ where: { id: raceId }, data: { scanStartedAt: new Date(Date.now() - 120_000) } });
  const retryAttempt = scanQuarantinedMedia({ assetId: raceId, bytes: validPng, scanner: deferredScanner });
  await waitForCalls(2);
  calls[1]('CLEAN');
  assert.equal((await retryAttempt).scanStatus, MediaScanStatus.APPROVED);
  calls[0]('INFECTED');
  assert.equal((await olderAttempt).scanStatus, MediaScanStatus.APPROVED, 'a duplicate/late scanner result cannot overwrite the newer result');
  const raceFinal = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: raceId } });
  assert.equal(raceFinal.scanStatus, MediaScanStatus.APPROVED);
  assert.equal(raceFinal.scanAttemptCount, 2);
});

test.after(async () => { await prisma.$disconnect(); });
