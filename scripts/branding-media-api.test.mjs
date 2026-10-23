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
  throw new Error('Branding media API tests require the unique per-run E2E database to be the only configured database target.');
}

const [{ prisma, tokenHash }, { registerStoreMediaRoutes }, { registerBrandingMediaRoutes }, { registerPlatformRoutes }, { registerContentRoutes }, { registerStoreContentRoutes }, { effectiveStorePlan, asStorePlanEntitlements }, { env }, { Role, SellerStatus, MediaKind, MediaScanStatus, MediaUploadStatus, Prisma }, sharpModule] = await Promise.all([
  import('../apps/api/src/security.ts'),
  import('../apps/api/src/store-media-routes.ts'),
  import('../apps/api/src/branding-media-routes.ts'),
  import('../apps/api/src/platform-routes.ts'),
  import('../apps/api/src/content-routes.ts'),
  import('../apps/api/src/store-content-routes.ts'),
  import('../apps/api/src/store-plan-domain.ts'),
  import('../apps/api/src/config.ts'),
  import('@prisma/client'),
  import('sharp')
]);
const sharp = sharpModule.default;

class FakeManagedStorage {
  objects = new Map();
  failRead = new Set();
  async createUploadForm(key, contentType, maxBytes) {
    return { url: 'https://managed-upload.invalid/presigned', fields: { key, 'Content-Type': contentType, maxBytes: String(maxBytes) } };
  }
  async head(key) {
    const object = this.objects.get(key);
    if (!object) throw new Error('Synthetic uploaded object not found');
    return { ContentLength: object.bytes.length, ContentType: object.contentType };
  }
  async readLimited(key, maxBytes) {
    if (this.failRead.has(key)) throw new Error('Synthetic storage read failure');
    const object = this.objects.get(key);
    if (!object) throw new Error('Synthetic uploaded object not found');
    if (object.bytes.length > maxBytes) throw new Error('Synthetic object exceeds configured limit');
    return { bytes: object.bytes, contentLength: object.bytes.length, contentType: object.contentType };
  }
  async put(key, bytes, contentType) { this.objects.set(key, { bytes: Buffer.from(bytes), contentType }); }
  open(key) { const object = this.objects.get(key); return object ? Readable.from(object.bytes) : Readable.from([]); }
  async remove(key) { this.objects.delete(key); }
}

async function fixturePng() {
  return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 36, g: 97, b: 70, alpha: 1 } } }).png().toBuffer();
}

test('branding media APIs enforce tenant/role/quota, quarantine, replacement safety, and removal', async t => {
  const admin = await prisma.user.findUnique({ where: { email: 'admin.local@example.test' } });
  const owner = await prisma.user.findUnique({ where: { email: 'seller.local@example.test' }, include: { seller: { include: { store: true } } } });
  const buyer = await prisma.user.findUnique({ where: { email: 'buyer.local@example.test' } });
  const ownerSeller = owner?.seller;
  const ownerStore = ownerSeller?.store;
  assert.ok(admin && ownerSeller && ownerStore && buyer, 'seeded local admin, seller, and buyer are required');

  const runSuffix = crypto.randomUUID().replaceAll('-', '').toLowerCase();
  const testStaff = await prisma.user.create({ data: { email: `branding-staff-${runSuffix}@example.test`, name: 'Branding Test Staff', passwordHash: 'not-used-in-this-test', role: Role.CASHIER } });
  const otherOwner = await prisma.user.create({ data: { email: `branding-other-${runSuffix}@example.test`, name: 'Other Store Owner', passwordHash: 'not-used-in-this-test', role: Role.SELLER } });
  const otherSeller = await prisma.seller.create({ data: { userId: otherOwner.id, status: SellerStatus.APPROVED, store: { create: { name: `Other Branding ${runSuffix}`, slug: `other-branding-${runSuffix}` } } } });
  const otherStore = await prisma.store.findUniqueOrThrow({ where: { sellerId: otherSeller.id } });
  const membership = await prisma.sellerStaff.create({ data: { sellerId: ownerSeller.id, userId: testStaff.id, canManageStoreBranding: false } });

  const oldBranding = await prisma.platformBranding.findUnique({ where: { id: 'default' } });
  const oldStore = await prisma.store.findUniqueOrThrow({ where: { id: ownerStore.id } });
  const sessionRows = [];
  const mediaIds = [];
  let testStorePageId;
  let quotaMediaId;
  let server;
  const storage = new FakeManagedStorage();
  const tokens = new Map();

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const cookie = req.cookies?.marketplace_csrf;
    if (!cookie || cookie !== req.get('x-csrf-token')) return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  });
  registerContentRoutes(app, (_provider, key) => storage.open(key));
  registerPlatformRoutes(app);
  registerStoreContentRoutes(app);
  registerStoreMediaRoutes(app, storage);
  registerBrandingMediaRoutes(app, storage);
  app.use((error, _req, res, _next) => {
    const status = error.statusCode ?? 500;
    if (!error.statusCode) return res.status(status).json({ error: 'Internal server error', testDiagnostic: error.message ?? String(error) });
    const body = { error: error.message ?? 'Request failed' };
    for (const field of ['code', 'entitlement', 'usage', 'requested', 'limit', 'upgradeRequired', 'planUrl']) {
      if (error[field] !== undefined) body[field] = error[field];
    }
    return res.status(status).json(body);
  });

  for (const [key, user] of [['admin', admin], ['owner', owner], ['buyer', buyer], ['staff', testStaff], ['other', otherOwner]]) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    const row = await prisma.session.create({ data: { tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    sessionRows.push(row.id);
    tokens.set(key, { cookie: `${env.SESSION_COOKIE_NAME}=${token}; marketplace_csrf=${csrf}`, csrf });
  }

  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await prisma.store.update({ where: { id: oldStore.id }, data: { themeDraftJson: oldStore.themeDraftJson ?? Prisma.DbNull, themePublishedJson: oldStore.themePublishedJson ?? Prisma.DbNull, themePublishedAt: oldStore.themePublishedAt } });
    if (oldBranding) await prisma.platformBranding.update({ where: { id: 'default' }, data: { draftJson: oldBranding.draftJson, publishedJson: oldBranding.publishedJson ?? Prisma.DbNull, draftVersion: oldBranding.draftVersion, publishedVersion: oldBranding.publishedVersion, publishedAt: oldBranding.publishedAt, updatedById: oldBranding.updatedById } });
    else {
      await prisma.platformBrandingRevision.deleteMany({ where: { brandingId: 'default' } });
      await prisma.platformBranding.deleteMany({ where: { id: 'default' } });
    }
    if (testStorePageId) await prisma.contentPage.deleteMany({ where: { id: testStorePageId } });
    if (mediaIds.length) await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaIds } } });
    if (quotaMediaId) await prisma.mediaAsset.deleteMany({ where: { id: quotaMediaId } });
    await prisma.sellerStaff.deleteMany({ where: { id: membership.id } });
    await prisma.store.delete({ where: { id: otherStore.id } });
    await prisma.seller.delete({ where: { id: otherSeller.id } });
    await prisma.user.deleteMany({ where: { id: { in: [testStaff.id, otherOwner.id] } } });
    await prisma.session.deleteMany({ where: { id: { in: sessionRows } } });
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  async function call(who, method, url, body) {
    const auth = tokens.get(who);
    const headers = { Cookie: auth.cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': auth.csrf }) };
    return fetch(`${base}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const validPng = await fixturePng();

  const deniedAdminList = await call('buyer', 'GET', '/api/admin/platform/branding-media');
  assert.equal(deniedAdminList.status, 403, 'buyers cannot enumerate platform branding media');
  const deniedAdminUpload = await call('buyer', 'POST', '/api/admin/platform/branding-media/uploads', { fileName: 'logo.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(deniedAdminUpload.status, 403, 'buyers cannot reserve platform branding uploads');
  const deniedSellerUpload = await call('buyer', 'POST', '/api/seller/store-media/uploads', { fileName: 'logo.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(deniedSellerUpload.status, 403, 'buyers cannot reserve Store branding uploads');

  const invalidSvg = await call('admin', 'POST', '/api/admin/platform/branding-media/uploads', { fileName: 'logo.svg', contentType: 'image/svg+xml', sizeBytes: 120 });
  assert.equal(invalidSvg.status, 415, 'server rejects SVG regardless of client-provided content');
  const ownerSvg = await call('owner', 'POST', '/api/seller/store-media/uploads', { fileName: 'banner.svg', contentType: 'image/svg+xml', sizeBytes: 120 });
  assert.equal(ownerSvg.status, 415, 'Store upload API rejects SVG');
  const oversizedImage = await call('admin', 'POST', '/api/admin/platform/branding-media/uploads', { fileName: 'large.png', contentType: 'image/png', sizeBytes: env.CONTENT_MAX_IMAGE_BYTES + 1 });
  assert.equal(oversizedImage.status, 413, 'platform branding reservation enforces the configured image size limit');

  const deniedStaffBeforeGrant = await call('staff', 'GET', '/api/seller/store-media');
  assert.equal(deniedStaffBeforeGrant.status, 403, 'POS membership alone does not grant branding/media access');
  const deniedStaffUploadBeforeGrant = await call('staff', 'POST', '/api/seller/store-media/uploads', { fileName: 'favicon.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(deniedStaffUploadBeforeGrant.status, 403, 'POS membership alone does not grant branding upload access');
  const grant = await call('owner', 'PATCH', `/api/seller/store-branding/staff/${encodeURIComponent(testStaff.id)}`, { canManageStoreBranding: true });
  assert.equal(grant.status, 200);
  assert.equal((await grant.json()).canManageStoreBranding, true);
  const staffMediaList = await call('staff', 'GET', '/api/seller/store-media');
  assert.equal(staffMediaList.status, 200, 'explicitly authorized staff can use their own Store media');

  const quota = asStorePlanEntitlements((await effectiveStorePlan(prisma, ownerStore.id)).version).mediaStorageLimitBytes;
  quotaMediaId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: { id: quotaMediaId, storageKey: `test-quota/${quotaMediaId}`, originalName: 'quota-reservation.webp', safeName: 'quota-reservation.webp', kind: MediaKind.IMAGE, detectedMime: 'image/webp', sizeBytes: quota, checksum: 'quota-reservation', uploaderId: owner.id, storeId: ownerStore.id, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED } });
  const quotaResponse = await call('owner', 'POST', '/api/seller/store-media/uploads', { fileName: 'logo.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(quotaResponse.status, 409, 'Store Plan media quota blocks a new reservation at the limit');
  assert.equal((await quotaResponse.json()).code, 'PLAN_LIMIT_REACHED');
  await prisma.mediaAsset.delete({ where: { id: quotaMediaId } }); quotaMediaId = undefined;

  const otherAssetId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: { id: otherAssetId, storageKey: `stores/${otherStore.id}/media/${otherAssetId}.webp`, originalName: 'other-store.webp', safeName: 'other-store.webp', kind: MediaKind.IMAGE, detectedMime: 'image/webp', sizeBytes: 10, checksum: 'other-store-fixture', uploaderId: otherOwner.id, storeId: otherStore.id, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } });
  mediaIds.push(otherAssetId);
  const storeVideoId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: { id: storeVideoId, storageKey: `stores/${ownerStore.id}/media/${storeVideoId}.mp4`, originalName: 'store-video.mp4', safeName: 'store-video.mp4', kind: MediaKind.VIDEO, detectedMime: 'video/mp4', sizeBytes: 10, checksum: 'store-video-fixture', uploaderId: owner.id, storeId: ownerStore.id, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } });
  mediaIds.push(storeVideoId);
  const platformVideoId = crypto.randomUUID();
  await prisma.mediaAsset.create({ data: { id: platformVideoId, storageKey: `platform/media/${platformVideoId}.mp4`, originalName: 'platform-video.mp4', safeName: 'platform-video.mp4', kind: MediaKind.VIDEO, detectedMime: 'video/mp4', sizeBytes: 10, checksum: 'platform-video-fixture', uploaderId: admin.id, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } });
  mediaIds.push(platformVideoId);
  const foreignAssetPreview = await call('owner', 'GET', `/api/seller/store-media/${otherAssetId}/preview`);
  assert.equal(foreignAssetPreview.status, 404, 'seller cannot access another Store media even with a valid asset ID');
  const themeBefore = await call('owner', 'GET', '/api/seller/store-theme');
  assert.equal(themeBefore.status, 200);
  const theme = (await themeBefore.json()).draft;
  const crossStoreReference = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, logoMediaId: otherAssetId });
  assert.equal(crossStoreReference.status, 400, 'Store theme API rejects another Store media reference');
  const crossStoreFavicon = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, faviconMediaId: otherAssetId });
  assert.equal(crossStoreFavicon.status, 400, 'Store theme API rejects another Store favicon reference');
  const storeVideoFavicon = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, faviconMediaId: storeVideoId });
  assert.equal(storeVideoFavicon.status, 400, 'Store theme API rejects a completed video asset as a favicon');
  await assert.rejects(
    prisma.store.update({ where: { id: ownerStore.id }, data: { themeDraftJson: { ...theme, faviconMediaId: otherAssetId } } }),
    /Branding references must use complete image media within the permitted tenant scope/,
    'database trigger prevents bypassing the Store favicon ownership check'
  );
  await assert.rejects(
    prisma.store.update({ where: { id: ownerStore.id }, data: { themeDraftJson: { ...theme, faviconMediaId: storeVideoId } } }),
    /Branding references must use complete image media within the permitted tenant scope/,
    'database trigger rejects a video asset as Store branding'
  );

  const approvedStoreAssetId = crypto.randomUUID();
  const approvedStoreKey = `stores/${owner.seller.store.id}/media/${approvedStoreAssetId}.webp`;
  const approvedWebp = await sharp(validPng).webp().toBuffer();
  await prisma.mediaAsset.create({ data: { id: approvedStoreAssetId, storageKey: approvedStoreKey, originalName: 'previous-approved-logo.webp', safeName: 'previous-approved-logo.webp', kind: MediaKind.IMAGE, detectedMime: 'image/webp', sizeBytes: approvedWebp.length, checksum: 'prior-approved-logo', uploaderId: owner.id, storeId: owner.seller.store.id, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } });
  mediaIds.push(approvedStoreAssetId);
  storage.objects.set(approvedStoreKey, { bytes: approvedWebp, contentType: 'image/webp' });
  const establishPriorStoreImage = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, logoMediaId: approvedStoreAssetId, faviconMediaId: approvedStoreAssetId });
  assert.equal(establishPriorStoreImage.status, 200);
  const publishPriorStoreImage = await call('owner', 'POST', '/api/seller/store-theme/publish', {});
  assert.equal(publishPriorStoreImage.status, 200);
  const publicStoreTheme = await call('other', 'GET', `/api/stores/${ownerStore.slug}/theme`);
  assert.equal((await publicStoreTheme.json()).theme.faviconMediaId, approvedStoreAssetId, 'approved Store favicon is returned from the published theme');
  assert.equal((await call('other', 'GET', `/content-media/${approvedStoreAssetId}`)).status, 200, 'approved published Store favicon is publicly deliverable');
  await assert.rejects(
    prisma.mediaAsset.update({ where: { id: approvedStoreAssetId }, data: { kind: MediaKind.VIDEO } }),
    /Referenced branding media must remain a complete image/,
    'database trigger prevents a published Store image from being retyped as video'
  );
  const testPage = await prisma.contentPage.create({ data: { storeId: ownerStore.id, slug: `branding-favicon-${runSuffix}`, title: 'Store favicon check', bodyJson: [], status: 'PUBLISHED', editorId: owner.id, publishedAt: new Date() } });
  testStorePageId = testPage.id;
  const storePageHtml = await call('other', 'GET', `/store/${ownerStore.slug}/pages/${testPage.slug}`);
  assert.equal(storePageHtml.status, 200);
  assert.match(await storePageHtml.text(), new RegExp(`<link rel="icon" href="/content-media/${approvedStoreAssetId}">`), 'published Store content page includes the approved Store favicon');

  const sellerReservationResponse = await call('owner', 'POST', '/api/seller/store-media/uploads', { fileName: 'store-logo.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(sellerReservationResponse.status, 201);
  const sellerReservation = await sellerReservationResponse.json();
  assert.equal(sellerReservation.upload.fields.maxBytes, String(validPng.length), 'Store upload policy is scoped to the reserved byte count');
  mediaIds.push(sellerReservation.id);
  const sellerTempKey = `pending/${owner.seller.store.id}/${sellerReservation.id}`;
  storage.objects.set(sellerTempKey, { bytes: validPng, contentType: 'image/png' });
  const sellerFinalize = await call('owner', 'POST', `/api/seller/store-media/${sellerReservation.id}/finalize`, {});
  assert.equal(sellerFinalize.status, 202, 'missing scanner configuration keeps the completed upload quarantined');
  const sellerMedia = await sellerFinalize.json();
  assert.equal(sellerMedia.uploadStatus, 'COMPLETE');
  assert.equal(sellerMedia.scanStatus, 'QUARANTINED');
  assert.equal(sellerMedia.scanErrorCode, 'SCANNER_UNAVAILABLE');
  assert.equal(sellerMedia.publicAfterUpload, false);
  const publicQuarantine = await call('buyer', 'GET', `/content-media/${sellerReservation.id}`);
  assert.equal(publicQuarantine.status, 404, 'quarantined Store media is not public');
  const ownerPreview = await call('owner', 'GET', `/api/seller/store-media/${sellerReservation.id}/preview`);
  assert.equal(ownerPreview.status, 200, 'authorized owner can privately preview its quarantined normalized asset');
  const otherStorePreview = await call('other', 'GET', `/api/seller/store-media/${sellerReservation.id}/preview`);
  assert.equal(otherStorePreview.status, 404, 'another Store cannot preview the asset');
  const staffPreview = await call('staff', 'GET', `/api/seller/store-media/${sellerReservation.id}/preview`);
  assert.equal(staffPreview.status, 200, 'explicitly authorized staff can privately preview same-Store media');

  const saveStoreDraft = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, logoMediaId: sellerReservation.id, faviconMediaId: sellerReservation.id });
  assert.equal(saveStoreDraft.status, 200, 'complete quarantined media can be saved only as a draft');
  const publishQuarantinedStore = await call('owner', 'POST', '/api/seller/store-theme/publish', {});
  assert.equal(publishQuarantinedStore.status, 409, 'quarantined replacement cannot publish');
  const publishedAfterBlockedStoreReplace = await call('other', 'GET', `/api/stores/${owner.seller.store.slug}/theme`);
  assert.equal(publishedAfterBlockedStoreReplace.status, 200);
  const publicStoreAfterBlockedReplace = (await publishedAfterBlockedStoreReplace.json()).theme;
  assert.equal(publicStoreAfterBlockedReplace.logoMediaId, approvedStoreAssetId, 'quarantined replacement leaves the approved public Store image active');
  assert.equal(publicStoreAfterBlockedReplace.faviconMediaId, approvedStoreAssetId, 'quarantined replacement leaves the approved public Store favicon active');

  const failedReservationResponse = await call('owner', 'POST', '/api/seller/store-media/uploads', { fileName: 'failed-replacement.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(failedReservationResponse.status, 201);
  const failedReservation = await failedReservationResponse.json();
  mediaIds.push(failedReservation.id);
  const failedKey = `pending/${owner.seller.store.id}/${failedReservation.id}`;
  storage.objects.set(failedKey, { bytes: validPng, contentType: 'image/png' });
  storage.failRead.add(failedKey);
  const failedFinalize = await call('owner', 'POST', `/api/seller/store-media/${failedReservation.id}/finalize`, {});
  assert.equal(failedFinalize.status, 503, `storage verification failure is reported as recoverable, not successful: ${JSON.stringify(await failedFinalize.clone().json())}`);
  assert.equal((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: failedReservation.id } })).uploadStatus, MediaUploadStatus.PENDING, 'transient storage failure keeps the reservation retryable');
  const unchangedDraft = await call('owner', 'GET', '/api/seller/store-theme');
  assert.equal((await unchangedDraft.json()).draft.logoMediaId, sellerReservation.id, 'failed replacement does not replace the selected working image');
  const stillPublishedStoreLogo = await call('other', 'GET', `/api/stores/${owner.seller.store.slug}/theme`);
  const publicStoreAfterFailedReplace = (await stillPublishedStoreLogo.json()).theme;
  assert.equal(publicStoreAfterFailedReplace.logoMediaId, approvedStoreAssetId, 'failed storage verification leaves the prior approved Store image public');
  assert.equal(publicStoreAfterFailedReplace.faviconMediaId, approvedStoreAssetId, 'failed storage verification leaves the prior approved Store favicon public');

  const removeStoreDraft = await call('owner', 'PUT', '/api/seller/store-theme', { ...theme, logoMediaId: null, faviconMediaId: null });
  assert.equal(removeStoreDraft.status, 200);
  const publishRemoval = await call('owner', 'POST', '/api/seller/store-theme/publish', {});
  assert.equal(publishRemoval.status, 200, 'approved removal can be published');
  const removedTheme = await call('other', 'GET', `/api/stores/${owner.seller.store.slug}/theme`);
  const removedPublicTheme = (await removedTheme.json()).theme;
  assert.equal(removedPublicTheme.logoMediaId, null, 'logo removal clears only the public reference, not the stored media row');
  assert.equal(removedPublicTheme.faviconMediaId, null, 'favicon removal clears the public favicon reference');

  const platformReservationResponse = await call('admin', 'POST', '/api/admin/platform/branding-media/uploads', { fileName: 'platform-logo.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(platformReservationResponse.status, 201);
  const platformReservation = await platformReservationResponse.json();
  assert.equal(platformReservation.upload.fields.maxBytes, String(validPng.length), 'Platform upload policy is scoped to the reserved byte count');
  mediaIds.push(platformReservation.id);
  const platformTempKey = `platform/branding/pending/${platformReservation.id}`;
  storage.objects.set(platformTempKey, { bytes: validPng, contentType: 'image/png' });
  const platformFinalize = await call('admin', 'POST', `/api/admin/platform/branding-media/${platformReservation.id}/finalize`, {});
  assert.equal(platformFinalize.status, 202, 'missing scanner configuration keeps platform branding quarantined');
  const platformMedia = await platformFinalize.json();
  assert.equal(platformMedia.scanStatus, 'QUARANTINED');
  assert.equal(platformMedia.scanErrorCode, 'SCANNER_UNAVAILABLE');
  assert.equal(platformMedia.publicAfterUpload, false);
  const adminBrandingDraft = { platformName: 'Brand Test', shortName: 'Brand Test', description: '', seoDescription: '', tagline: '', logoMediaId: platformReservation.id, alternateLogoMediaId: null, faviconMediaId: platformReservation.id, defaultAvatarMediaId: null, socialImageMediaId: null, supportEmail: null, supportUrl: null };
  const saveBrandDraft = await call('admin', 'PUT', '/api/admin/platform/branding', adminBrandingDraft);
  assert.equal(saveBrandDraft.status, 200);
  const nonImagePlatformFavicon = await call('admin', 'PUT', '/api/admin/platform/branding', { ...adminBrandingDraft, faviconMediaId: platformVideoId });
  assert.equal(nonImagePlatformFavicon.status, 400, 'admin API rejects a completed video as platform favicon');
  await assert.rejects(
    prisma.platformBranding.update({ where: { id: 'default' }, data: { draftJson: { ...adminBrandingDraft, faviconMediaId: platformVideoId } } }),
    /Branding references must use complete image media within the permitted tenant scope/,
    'database trigger rejects a video asset as platform branding'
  );
  const publishBlocked = await call('admin', 'POST', '/api/admin/platform/branding/publish', {});
  assert.equal(publishBlocked.status, 409, 'quarantined platform image cannot be published');
  const publicBrandingDuringReplace = await call('buyer', 'GET', '/api/platform/branding');
  const publicBrandingBeforeApproval = await publicBrandingDuringReplace.json();
  assert.notEqual(publicBrandingBeforeApproval.logoMediaId, platformReservation.id, 'pending image never displaces current public branding');
  assert.notEqual(publicBrandingBeforeApproval.faviconMediaId, platformReservation.id, 'pending image never displaces the current public favicon');
  await prisma.mediaAsset.update({ where: { id: platformReservation.id }, data: { scanStatus: MediaScanStatus.APPROVED } });
  const publishApprovedBrand = await call('admin', 'POST', '/api/admin/platform/branding/publish', {});
  assert.equal(publishApprovedBrand.status, 200, 'scanner-approved platform replacement can be published');
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).logoMediaId, platformReservation.id);
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).faviconMediaId, platformReservation.id);
  await assert.rejects(
    prisma.mediaAsset.update({ where: { id: platformReservation.id }, data: { kind: MediaKind.VIDEO } }),
    /Referenced branding media must remain a complete image/,
    'database trigger prevents a published platform image from being retyped as video'
  );

  const platformFailureResponse = await call('admin', 'POST', '/api/admin/platform/branding-media/uploads', { fileName: 'platform-failure.png', contentType: 'image/png', sizeBytes: validPng.length });
  assert.equal(platformFailureResponse.status, 201);
  const platformFailure = await platformFailureResponse.json();
  mediaIds.push(platformFailure.id);
  const platformFailureKey = `platform/branding/pending/${platformFailure.id}`;
  storage.objects.set(platformFailureKey, { bytes: validPng, contentType: 'image/png' });
  storage.failRead.add(platformFailureKey);
  const platformFailedFinalize = await call('admin', 'POST', `/api/admin/platform/branding-media/${platformFailure.id}/finalize`, {});
  assert.equal(platformFailedFinalize.status, 503, 'failed platform replacement remains unavailable');
  const platformDraftAfterFailure = await call('admin', 'GET', '/api/admin/platform/branding');
  assert.equal((await platformDraftAfterFailure.json()).draftJson.logoMediaId, platformReservation.id, 'failed replacement does not overwrite the saved branding reference');
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).logoMediaId, platformReservation.id, 'failed replacement preserves the currently published approved platform logo');
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).faviconMediaId, platformReservation.id, 'failed replacement preserves the currently published approved platform favicon');
  const removeBrandDraft = await call('admin', 'PUT', '/api/admin/platform/branding', { ...adminBrandingDraft, logoMediaId: null, faviconMediaId: null });
  assert.equal(removeBrandDraft.status, 200);
  const publishBrandRemoval = await call('admin', 'POST', '/api/admin/platform/branding/publish', {});
  assert.equal(publishBrandRemoval.status, 200);
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).logoMediaId, null);
  assert.equal((await (await call('buyer', 'GET', '/api/platform/branding')).json()).faviconMediaId, null);
});

test.after(async () => { await prisma.$disconnect(); });
