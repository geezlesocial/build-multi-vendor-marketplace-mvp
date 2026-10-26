import crypto from 'node:crypto';
import path from 'node:path';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import sharp from 'sharp';
import { MediaKind, MediaScanStatus, MediaUploadStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { objectContentStorage, localContentStorage } from './content-storage.js';
import type { ManagedContentStorage } from './content-storage.js';
import { detectStoreMedia } from './store-media-routes.js';
import { authorizedBrandingAsset } from './store-branding-access.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const idParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; sellerId?: string };
const imageTypes: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'] };
const uploadTtlMs = 60 * 60 * 1000;

export function registerBrandingMediaRoutes(app: Express, storage: ManagedContentStorage | null = objectContentStorage, scanner: MalwareScanner | null = malwareScanner) {
  const localMode = storage === null;
  const activeStorage = storage ?? localContentStorage;
  app.get('/api/admin/platform/branding-media', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    res.json(await prisma.mediaAsset.findMany({
      where: { storeId: null, kind: MediaKind.IMAGE, storageProvider: { in: ['OBJECT', 'LOCAL'] } }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, originalName: true, safeName: true, detectedMime: true, sizeBytes: true, width: true, height: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true, uploadStatus: true, storageProvider: true, createdAt: true }
    }));
  }));

  app.post('/api/admin/platform/branding-media/uploads', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().positive() }).strict().parse(req.body);
    const extension = path.extname(input.fileName).slice(1).toLowerCase();
    if (!imageTypes[input.contentType]?.includes(extension)) throw fail(415, 'Choose a PNG, JPEG, WebP, or GIF image with a matching file extension.');
    if (input.sizeBytes > env.CONTENT_MAX_IMAGE_BYTES) throw fail(413, 'Image exceeds the configured file-size limit.');
    const id = crypto.randomUUID();
    const storageKey = `platform/branding/pending/${id}`;
    const asset = await prisma.mediaAsset.create({ data: {
      id, storageKey, originalName: input.fileName, safeName: input.fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120),
      kind: MediaKind.IMAGE, detectedMime: input.contentType, sizeBytes: input.sizeBytes,
      checksum: crypto.createHash('sha256').update(`pending:${id}`).digest('hex'), uploaderId: user.id,
      purpose: 'PLATFORM_BRANDING', storageProvider: localMode ? 'LOCAL' : 'OBJECT', uploadStatus: MediaUploadStatus.PENDING, scanStatus: MediaScanStatus.QUARANTINED
    } });
    try {
      const upload = storage
        ? await storage.createUploadForm(storageKey, input.contentType, input.sizeBytes)
        : { url: `/api/admin/platform/branding-media/${encodeURIComponent(id)}/local-upload`, fields: { 'x-local-upload': '1' } };
      await audit(user.id, 'PLATFORM_BRANDING_MEDIA_UPLOAD_RESERVED', 'MediaAsset', id, { kind: 'IMAGE', sizeBytes: input.sizeBytes });
      res.status(201).json({ id, upload, expiresInSeconds: 300, scanStatus: asset.scanStatus, publicAfterUpload: false });
    } catch {
      await prisma.mediaAsset.update({ where: { id }, data: { uploadStatus: MediaUploadStatus.FAILED } });
      throw fail(503, 'A temporary upload authorization could not be issued. The current published branding image remains active.');
    }
  }));

  // Local development fallback. Production/staging should use the managed object-storage path above.
  app.put('/api/admin/platform/branding-media/:id/local-upload', requireAuth, requireRole(Role.ADMIN), express.raw({ type: '*/*', limit: env.CONTENT_MAX_IMAGE_BYTES }), run(async (req, res) => {
    if (!localMode) throw fail(404, 'Local branding uploads are disabled when managed object storage is enabled.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: idParam(req.params.id), storeId: null, purpose: 'PLATFORM_BRANDING', uploaderId: actor(res).id, storageProvider: 'LOCAL', uploadStatus: MediaUploadStatus.PENDING } });
    if (!asset) throw fail(404, 'Pending branding image upload not found.');
    const rawBody: unknown = req.body;
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    const contentType = (req.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!bytes.length || bytes.length !== asset.sizeBytes || contentType !== asset.detectedMime) throw fail(400, 'Uploaded image size or type does not match its reservation.');
    await activeStorage.put(asset.storageKey, bytes, asset.detectedMime);
    res.status(204).send();
  }));

  app.post('/api/admin/platform/branding-media/:id/finalize', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    if (!activeStorage) throw fail(503, 'Managed shared storage is unavailable. The current published branding image remains active.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: idParam(req.params.id), storeId: null, uploaderId: user.id, kind: MediaKind.IMAGE, storageProvider: { in: ['OBJECT', 'LOCAL'] }, uploadStatus: { in: [MediaUploadStatus.PENDING, MediaUploadStatus.COMPLETE] } } });
    if (!asset) throw fail(404, 'Pending branding image upload not found.');
    if (asset.uploadStatus === MediaUploadStatus.COMPLETE) return res.json({ id: asset.id, safeName: asset.safeName, detectedMime: asset.detectedMime, sizeBytes: asset.sizeBytes, width: asset.width, height: asset.height, scanStatus: asset.scanStatus, scanErrorCode: asset.scanErrorCode, scanAttemptCount: asset.scanAttemptCount, uploadStatus: asset.uploadStatus, publicAfterUpload: false, message: 'This upload was already finalized. Its saved scan state is unchanged.' });
    if (asset.createdAt < new Date(Date.now() - uploadTtlMs)) {
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.PENDING }, data: { uploadStatus: MediaUploadStatus.FAILED } });
      await activeStorage.remove(asset.storageKey).catch(() => undefined);
      throw fail(410, 'Upload authorization expired. Choose the image again to retry.');
    }
    const claim = await prisma.mediaAsset.updateMany({ where: { id: asset.id, storeId: null, uploaderId: user.id, uploadStatus: MediaUploadStatus.PENDING }, data: { uploadStatus: MediaUploadStatus.VERIFYING } });
    if (claim.count !== 1) throw fail(409, 'Upload is already being verified or is no longer available.');
    let finalKey: string | null = null;
    let persisted = false;
    try {
      const head = await activeStorage.head(asset.storageKey);
      if (head.ContentLength !== asset.sizeBytes || head.ContentLength > env.CONTENT_MAX_IMAGE_BYTES || head.ContentType !== asset.detectedMime) throw fail(400, 'Uploaded image size or type does not match its reservation.');
      const read = await activeStorage.readLimited(asset.storageKey, env.CONTENT_MAX_IMAGE_BYTES);
      if (read.bytes.length !== asset.sizeBytes || read.contentLength !== asset.sizeBytes || read.contentType !== asset.detectedMime) throw fail(400, 'Uploaded image metadata does not match its reservation.');
      const extension = path.extname(asset.originalName).slice(1).toLowerCase();
      const detected = detectStoreMedia(read.bytes, extension, asset.detectedMime);
      if (detected.kind !== MediaKind.IMAGE) throw fail(415, 'Only supported raster images may be used for branding.');
      const image = sharp(read.bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw fail(415, 'Image data could not be safely decoded.');
      const normalized = await image.rotate().webp({ quality: 86 }).toBuffer();
      if (normalized.length > env.CONTENT_MAX_IMAGE_BYTES) throw fail(413, 'Normalized image exceeds the configured file-size limit.');
      finalKey = `platform/branding/${asset.id}.webp`;
      await activeStorage.put(finalKey, normalized, 'image/webp');
      const updated = await prisma.$transaction(async tx => {
        const result = await tx.mediaAsset.updateMany({ where: { id: asset.id, storeId: null, uploaderId: user.id, uploadStatus: MediaUploadStatus.VERIFYING }, data: {
          storageKey: finalKey!, safeName: `${path.parse(asset.safeName).name}.webp`, detectedMime: 'image/webp', sizeBytes: normalized.length,
          width: metadata.width!, height: metadata.height!, checksum: crypto.createHash('sha256').update(normalized).digest('hex'),
          purpose: 'PLATFORM_BRANDING', uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, scanErrorCode: null, scanAttemptId: null, scanStartedAt: null, scanCompletedAt: null, scannerProvider: null
        } });
        if (result.count !== 1) throw fail(409, 'Upload is no longer available.');
        await tx.auditLog.create({ data: { actorId: user.id, action: 'PLATFORM_BRANDING_MEDIA_QUARANTINED', entity: 'MediaAsset', entityId: asset.id, metadata: { sizeBytes: normalized.length, scanStatus: 'QUARANTINED' } } });
        return tx.mediaAsset.findUnique({ where: { id: asset.id }, select: { id: true, safeName: true, detectedMime: true, sizeBytes: true, width: true, height: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true, uploadStatus: true } });
      });
      persisted = true;
      await activeStorage.remove(asset.storageKey).catch(() => undefined);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: normalized, scanner, actorId: user.id });
      res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ ...updated, ...scan, publicAfterUpload: false, message: scan.scanStatus === MediaScanStatus.APPROVED ? 'Image uploaded, normalized, and scanned. Save and publish to make it public.' : scan.scanErrorCode === 'MALWARE_DETECTED' ? 'The scanner rejected this image. It remains private and cannot be published.' : 'Image uploaded and normalized, but remains private in quarantine until the configured scanner approves it.' });
    } catch (error) {
      if (persisted) return res.status(202).json({ id: asset.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, publicAfterUpload: false, message: 'The image is safely stored in private quarantine, but its scan result could not be confirmed. The currently published branding remains active; retry the scan later.' });
      if (finalKey) await activeStorage.remove(finalKey).catch(() => undefined);
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 503;
      if (status >= 400 && status < 500) await activeStorage.remove(asset.storageKey).catch(() => undefined);
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.VERIFYING }, data: { uploadStatus: status >= 400 && status < 500 ? MediaUploadStatus.FAILED : MediaUploadStatus.PENDING } });
      if (status >= 400 && status < 500) throw error;
      throw fail(503, 'Image verification or managed storage failed. The asset is unavailable and the current published branding image remains active; retry later.');
    }
  }));

  app.post('/api/admin/platform/branding-media/:id/scan-retry', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const asset = await prisma.mediaAsset.findFirst({ where: { id: idParam(req.params.id), storeId: null, purpose: 'PLATFORM_BRANDING', kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, storageProvider: { in: ['OBJECT', 'LOCAL'] } } });
    if (!asset) throw fail(404, 'Quarantined platform branding image not found.');
    if (!scanner) {
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: Buffer.alloc(0), scanner, actorId: user.id });
      return res.status(202).json({ ...scan, message: 'The malware scanner is unavailable. The image remains private.' });
    }
    try {
      const read = await activeStorage.readLimited(asset.storageKey, env.CONTENT_MAX_IMAGE_BYTES);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: read.bytes, scanner, actorId: user.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json(scan);
    } catch {
      return res.status(503).json({ error: 'The private branding image could not be read for scanning. It remains quarantined; retry later.', code: 'MEDIA_READ_UNAVAILABLE' });
    }
  }));

  app.get('/api/admin/platform/branding-media/:id/preview', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: idParam(req.params.id), storeId: null, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: { not: MediaScanStatus.REJECTED } } });
    if (!asset) return res.status(404).json({ error: 'Branding image not found.' });
    if (asset.storageProvider === 'OBJECT' && !storage) throw fail(503, 'Managed shared storage is unavailable.');
    res.set({ 'Content-Type': asset.detectedMime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    activeStorage.open(asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));

  app.get('/api/seller/store-media/:id/preview', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const found = await authorizedBrandingAsset(actor(res), idParam(req.params.id));
    if (!found) return res.status(404).json({ error: 'Store image not found.' });
    if (found.asset.storageProvider === 'OBJECT' && !storage) throw fail(503, 'Managed shared storage is unavailable.');
    res.set({ 'Content-Type': found.asset.detectedMime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    (found.asset.storageProvider === 'OBJECT' ? storage!.open(found.asset.storageKey) : localContentStorage.open(found.asset.storageKey)).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));
}
