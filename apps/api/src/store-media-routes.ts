import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'node:path';
import sharp from 'sharp';
import { MediaKind, MediaScanStatus, MediaUploadStatus, Role } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { effectiveStorePlan, asStorePlanEntitlements } from './store-plan-domain.js';
import { objectContentStorage } from './content-storage.js';
import type { ManagedContentStorage } from './content-storage.js';
import { authorizedBrandingStore } from './store-branding-access.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, extra?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...extra });
const user = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

type DetectedFile = { kind: MediaKind; mime: string; extension: string };
const supportedTypes: Record<string, { kind: MediaKind; extensions: string[] }> = {
  'image/png': { kind: MediaKind.IMAGE, extensions: ['png'] },
  'image/jpeg': { kind: MediaKind.IMAGE, extensions: ['jpg', 'jpeg'] },
  'image/webp': { kind: MediaKind.IMAGE, extensions: ['webp'] },
  'image/gif': { kind: MediaKind.IMAGE, extensions: ['gif'] },
  'video/mp4': { kind: MediaKind.VIDEO, extensions: ['mp4'] },
  'video/webm': { kind: MediaKind.VIDEO, extensions: ['webm'] },
  'video/ogg': { kind: MediaKind.VIDEO, extensions: ['ogv', 'ogg'] },
  'application/pdf': { kind: MediaKind.DOCUMENT, extensions: ['pdf'] },
  'text/csv': { kind: MediaKind.DOCUMENT, extensions: ['csv'] },
  'text/vtt': { kind: MediaKind.CAPTION, extensions: ['vtt'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: MediaKind.DOCUMENT, extensions: ['docx'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: MediaKind.DOCUMENT, extensions: ['xlsx'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: MediaKind.DOCUMENT, extensions: ['pptx'] }
};

export function detectStoreMedia(bytes: Buffer, extension: string, claimedMime: string): DetectedFile {
  let detected: DetectedFile | null = null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = { kind: MediaKind.IMAGE, mime: 'image/png', extension: 'png' };
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) detected = { kind: MediaKind.IMAGE, mime: 'image/jpeg', extension: 'jpg' };
  else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) detected = { kind: MediaKind.IMAGE, mime: 'image/gif', extension: 'gif' };
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') detected = { kind: MediaKind.IMAGE, mime: 'image/webp', extension: 'webp' };
  else if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') detected = { kind: MediaKind.VIDEO, mime: 'video/mp4', extension: 'mp4' };
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) detected = { kind: MediaKind.VIDEO, mime: 'video/webm', extension: 'webm' };
  else if (bytes.subarray(0, 4).toString('ascii') === 'OggS') detected = { kind: MediaKind.VIDEO, mime: 'video/ogg', extension: 'ogv' };
  else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') detected = { kind: MediaKind.DOCUMENT, mime: 'application/pdf', extension: 'pdf' };
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && ['docx', 'xlsx', 'pptx'].includes(extension)) detected = { kind: MediaKind.DOCUMENT, mime: ({ docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as const)[extension as 'docx' | 'xlsx' | 'pptx'], extension };
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw fail(415, 'File extension does not match a supported Office document content type.');
  else if (bytes.subarray(0, 7).toString('utf8').toUpperCase().startsWith('WEBVTT')) detected = { kind: MediaKind.CAPTION, mime: 'text/vtt', extension: 'vtt' };
  else if (extension === 'csv' && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(bytes.toString('utf8'))) detected = { kind: MediaKind.DOCUMENT, mime: 'text/csv', extension: 'csv' };
  if (!detected || detected.mime !== claimedMime) throw fail(415, 'File content does not match a supported media type.');
  const allowed = supportedTypes[claimedMime];
  if (!allowed || !allowed.extensions.includes(extension)) throw fail(415, 'File extension does not match its verified content type.');
  return detected;
}

function maxBytes(kind: MediaKind) {
  return kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : kind === MediaKind.VIDEO ? env.CONTENT_MAX_VIDEO_BYTES : env.CONTENT_MAX_DOCUMENT_BYTES;
}

const uploadReservationTtlMs = 60 * 60 * 1000;
const activeReservationWhere = (storeId: string, since: Date, exceptId?: string): Prisma.MediaAssetWhereInput => ({
  storeId,
  ...(exceptId ? { id: { not: exceptId } } : {}),
  OR: [
    { uploadStatus: MediaUploadStatus.COMPLETE },
    { uploadStatus: { in: [MediaUploadStatus.PENDING, MediaUploadStatus.VERIFYING] }, createdAt: { gte: since } }
  ]
});

export function registerStoreMediaRoutes(app: Express, storage: ManagedContentStorage | null = objectContentStorage, scanner: MalwareScanner | null = malwareScanner) {
  app.post('/api/seller/store-media/uploads', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const userActor = user(res);
    if (!userActor.sellerId) throw fail(403, 'Seller scope required.');
    const input = z.object({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().positive() }).strict().parse(req.body);
    const extension = path.extname(input.fileName).slice(1).toLowerCase();
    const type = supportedTypes[input.contentType];
    if (!type || !type.extensions.includes(extension)) throw fail(415, 'Choose a supported image, video, or document file.');
    if (userActor.role === Role.CASHIER && type.kind !== MediaKind.IMAGE) throw fail(403, 'Branding staff may upload image assets only.');
    const limit = maxBytes(type.kind);
    if (input.sizeBytes > limit) throw fail(413, 'File exceeds the configured per-file size limit.');
    const store = await authorizedBrandingStore(userActor);
    if (!store) throw fail(403, 'An approved Store owner or authorized branding staff member is required.');
    if (!storage) throw fail(503, 'Managed browser uploads are not configured. The currently published Store image remains active.');
    const id = crypto.randomUUID();
    const temporaryKey = `pending/${store.id}/${id}`;
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
    const media = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
      const stale = await tx.mediaAsset.findMany({ where: { storeId: store.id, uploadStatus: { in: ['PENDING', 'VERIFYING'] }, createdAt: { lt: expiresBefore } }, select: { id: true, storageKey: true } });
      if (stale.length) await tx.mediaAsset.updateMany({ where: { id: { in: stale.map(item => item.id) }, storeId: store.id, uploadStatus: { in: ['PENDING', 'VERIFYING'] } }, data: { uploadStatus: 'FAILED' } });
      const entitlements = asStorePlanEntitlements((await effectiveStorePlan(tx, store.id)).version);
      const reserved = await tx.mediaAsset.aggregate({ where: activeReservationWhere(store.id, expiresBefore), _sum: { sizeBytes: true } });
      const usage = reserved._sum?.sizeBytes ?? 0;
      if (usage + input.sizeBytes > entitlements.mediaStorageLimitBytes) throw fail(409, 'Your Store has reached its media storage limit.', { code: 'PLAN_LIMIT_REACHED', entitlement: 'mediaStorageLimitBytes', usage, requested: input.sizeBytes, limit: entitlements.mediaStorageLimitBytes, upgradeRequired: true, planUrl: '/seller/plan' });
      const asset = await tx.mediaAsset.create({ data: { id, storageKey: temporaryKey, originalName: input.fileName, safeName, kind: type.kind, detectedMime: input.contentType, sizeBytes: input.sizeBytes, checksum: crypto.createHash('sha256').update(`pending:${id}`).digest('hex'), uploaderId: userActor.id, storeId: store.id, purpose: 'STORE_MEDIA', uploadStatus: 'PENDING', storageProvider: 'OBJECT', scanStatus: MediaScanStatus.QUARANTINED } });
      await tx.auditLog.create({ data: { actorId: userActor.id, action: 'STORE_MEDIA_UPLOAD_RESERVED', entity: 'MediaAsset', entityId: asset.id, metadata: { storeId: store.id, kind: type.kind, sizeBytes: input.sizeBytes } } });
      return { asset, staleKeys: stale.map(item => item.storageKey) };
    });
    await Promise.all(media.staleKeys.map(key => storage.remove(key).catch(() => undefined)));
    try {
      const upload = await storage.createUploadForm(media.asset.storageKey, input.contentType, input.sizeBytes);
      res.status(201).json({ id: media.asset.id, upload, expiresInSeconds: 300, scanStatus: media.asset.scanStatus, publicAfterUpload: false });
    } catch {
      await prisma.mediaAsset.update({ where: { id: media.asset.id }, data: { uploadStatus: 'FAILED' } });
      throw fail(503, 'A temporary upload authorization could not be issued. Retry safely.');
    }
  }));

  app.get('/api/seller/store-media', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (_req, res) => {
    const userActor = user(res);
    if (!userActor.sellerId) throw fail(403, 'Seller scope required.');
    const store = await authorizedBrandingStore(userActor);
    if (!store) throw fail(403, 'An approved Store owner or authorized branding staff member is required.');
    const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
    const staleKeys = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const stale = await tx.mediaAsset.findMany({ where: { storeId: store.id, uploadStatus: { in: ['PENDING', 'VERIFYING'] }, createdAt: { lt: expiresBefore } }, select: { id: true, storageKey: true } });
      if (stale.length) await tx.mediaAsset.updateMany({ where: { id: { in: stale.map(item => item.id) }, storeId: store.id, uploadStatus: { in: ['PENDING', 'VERIFYING'] } }, data: { uploadStatus: 'FAILED' } });
      return stale.map(item => item.storageKey);
    });
    if (storage) await Promise.all(staleKeys.map(key => storage.remove(key).catch(() => undefined)));
    const [effective, usage, assets] = await Promise.all([
      effectiveStorePlan(prisma, store.id),
      prisma.mediaAsset.aggregate({ where: activeReservationWhere(store.id, expiresBefore), _sum: { sizeBytes: true } }),
      prisma.mediaAsset.findMany({ where: { storeId: store.id, ...(userActor.role === Role.CASHIER ? { kind: MediaKind.IMAGE } : {}) }, select: { id: true, originalName: true, kind: true, detectedMime: true, sizeBytes: true, width: true, height: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true, uploadStatus: true, storageProvider: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 })
    ]);
    res.json({ usedBytes: usage._sum.sizeBytes ?? 0, limitBytes: asStorePlanEntitlements(effective.version).mediaStorageLimitBytes, assets });
  }));

  app.post('/api/seller/store-media/:id/finalize', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const userActor = user(res);
    if (!userActor.sellerId) throw fail(403, 'Seller scope required.');
    if (!storage) throw fail(503, 'Managed browser uploads are not configured.');
    const store = await authorizedBrandingStore(userActor);
    if (!store) throw fail(403, 'An approved Store owner or authorized branding staff member is required.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), storeId: store.id, uploaderId: userActor.id, uploadStatus: { in: ['PENDING', 'COMPLETE'] }, storageProvider: 'OBJECT' } });
    if (!asset) throw fail(404, 'Pending upload not found.');
    if (asset.uploadStatus === MediaUploadStatus.COMPLETE) {
      return res.json({ id: asset.id, kind: asset.kind, detectedMime: asset.detectedMime, sizeBytes: asset.sizeBytes, width: asset.width, height: asset.height, scanStatus: asset.scanStatus, scanErrorCode: asset.scanErrorCode, uploadStatus: asset.uploadStatus, publicAfterUpload: false, message: 'This upload was already finalized. Its saved scan state is unchanged.' });
    }
    const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
    if (asset.createdAt < expiresBefore) {
      const expired = await prisma.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'PENDING', createdAt: { lt: expiresBefore } }, data: { uploadStatus: 'FAILED' } });
      if (expired.count) await storage.remove(asset.storageKey).catch(() => undefined);
      throw fail(410, 'This upload reservation expired. Choose the file again to create a fresh upload.');
    }
    let claimed = false;
    let persisted = false;
    const limit = maxBytes(asset.kind);
    let finalKey: string | null = null;
    try {
      const claim = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        return tx.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'PENDING', createdAt: { gte: expiresBefore } }, data: { uploadStatus: 'VERIFYING' } });
      });
      if (claim.count !== 1) throw fail(409, 'Upload is already being finalized or is no longer available.');
      claimed = true;
      const head = await storage.head(asset.storageKey);
      if (head.ContentLength !== asset.sizeBytes || head.ContentLength > limit || head.ContentType !== asset.detectedMime) throw fail(400, 'Uploaded object size or type does not match its reservation.');
      const read = await storage.readLimited(asset.storageKey, limit);
      const extension = path.extname(asset.originalName).slice(1).toLowerCase();
      const detected = detectStoreMedia(read.bytes, extension, asset.detectedMime);
      if (detected.kind !== asset.kind || read.bytes.length !== asset.sizeBytes) throw fail(400, 'Uploaded object did not match its reservation.');
      let bytes = read.bytes;
      let mime = detected.mime;
      let ext = detected.extension;
      let width: number | undefined;
      let height: number | undefined;
      if (detected.kind === MediaKind.IMAGE) {
        const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw fail(415, 'Image data could not be safely decoded.');
        width = metadata.width; height = metadata.height;
        bytes = await image.rotate().webp({ quality: 86 }).toBuffer();
        mime = 'image/webp'; ext = 'webp';
      }
      if (bytes.length > limit) throw fail(413, 'Normalized file exceeds the configured size limit.');
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const [entitlements, reserved] = await Promise.all([
          effectiveStorePlan(tx, store.id),
          tx.mediaAsset.aggregate({ where: activeReservationWhere(store.id, expiresBefore, asset.id), _sum: { sizeBytes: true } })
        ]);
        const allowance = asStorePlanEntitlements(entitlements.version).mediaStorageLimitBytes;
        if ((reserved._sum.sizeBytes ?? 0) + bytes.length > allowance) throw fail(409, 'Your Store has reached its media storage limit.', { code: 'PLAN_LIMIT_REACHED', entitlement: 'mediaStorageLimitBytes', limit: allowance, upgradeRequired: true, planUrl: '/seller/plan' });
        const changed = await tx.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'VERIFYING' }, data: { sizeBytes: bytes.length } });
        if (changed.count !== 1) throw fail(409, 'Upload was already finalized or is no longer available.');
      });
      finalKey = `stores/${store.id}/media/${asset.id}.${ext}`;
      await storage.put(finalKey, bytes, mime);
      const updated = await prisma.$transaction(async tx => {
        const changed = await tx.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'VERIFYING' }, data: { storageKey: finalKey!, uploadStatus: 'COMPLETE', detectedMime: mime, sizeBytes: bytes.length, width: width ?? null, height: height ?? null, durationMs: null, checksum: crypto.createHash('sha256').update(bytes).digest('hex'), safeName: `${path.parse(asset.safeName).name}.${ext}`, scanStatus: MediaScanStatus.QUARANTINED } });
        if (changed.count !== 1) throw fail(409, 'Upload was already finalized or is no longer available.');
        await tx.auditLog.create({ data: { actorId: userActor.id, action: 'STORE_MEDIA_UPLOAD_COMPLETED', entity: 'MediaAsset', entityId: asset.id, metadata: { storeId: store.id, kind: asset.kind, sizeBytes: bytes.length, scanStatus: 'QUARANTINED' } } });
        return tx.mediaAsset.findUnique({ where: { id: asset.id }, select: { id: true, kind: true, detectedMime: true, sizeBytes: true, width: true, height: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true, uploadStatus: true } });
      });
      persisted = true;
      await storage.remove(asset.storageKey).catch(() => undefined);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes, scanner, actorId: userActor.id });
      res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ ...updated, ...scan, publicAfterUpload: false, message: scan.scanStatus === MediaScanStatus.APPROVED ? 'Upload complete and scanned. It may now be selected for Store content.' : scan.scanErrorCode === 'MALWARE_DETECTED' ? 'The scanner rejected this file. It remains private and cannot be used.' : 'Upload complete, but the file remains private in quarantine until the configured scanner can approve it.' });
    } catch (error) {
      if (persisted) return res.status(202).json({ id: asset.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, publicAfterUpload: false, message: 'The upload is safely stored in private quarantine, but its scan result could not be confirmed. Retry the scan later.' });
      if (finalKey) await storage.remove(finalKey).catch(() => undefined);
      // Unknown errors from object storage/decoding infrastructure are transient
      // until proven otherwise. Keep the reservation retryable instead of marking
      // the media as a rejected upload.
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 503;
      if (claimed && (statusCode === 400 || statusCode === 413 || statusCode === 415)) await prisma.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'VERIFYING' }, data: { uploadStatus: 'FAILED' } });
      else if (claimed) await prisma.mediaAsset.updateMany({ where: { id: asset.id, storeId: store.id, uploaderId: userActor.id, uploadStatus: 'VERIFYING' }, data: { uploadStatus: 'PENDING', sizeBytes: asset.sizeBytes } });
      if (statusCode === 404) throw error;
      throw statusCode >= 400 && statusCode < 500 ? error : fail(503, 'The upload could not be safely verified. The asset remains unavailable; retry or contact support.');
    }
  }));

  app.post('/api/seller/store-media/:id/scan-retry', requireAuth, requireRole(Role.SELLER, Role.CASHIER), run(async (req, res) => {
    const userActor = user(res);
    if (!userActor.sellerId) throw fail(403, 'Seller scope required.');
    const store = await authorizedBrandingStore(userActor);
    if (!store) throw fail(403, 'An approved Store owner or authorized branding staff member is required.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), storeId: store.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, storageProvider: 'OBJECT' } });
    if (!asset) throw fail(404, 'Quarantined Store media not found.');
    if (!scanner) {
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: Buffer.alloc(0), scanner, actorId: userActor.id });
      return res.status(202).json({ ...scan, message: 'The malware scanner is unavailable. The asset remains private.' });
    }
    if (!storage) return res.status(503).json({ error: 'Managed shared storage is unavailable. The asset remains private.', code: 'MEDIA_STORAGE_UNAVAILABLE' });
    try {
      const read = await storage.readLimited(asset.storageKey, maxBytes(asset.kind));
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: read.bytes, scanner, actorId: userActor.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json(scan);
    } catch {
      return res.status(503).json({ error: 'The private media object could not be read for scanning. It remains quarantined; retry later.', code: 'MEDIA_READ_UNAVAILABLE' });
    }
  }));
}
