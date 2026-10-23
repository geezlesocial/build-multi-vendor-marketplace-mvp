import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Express, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { MediaKind, MediaPurpose, MediaScanStatus, MediaUploadStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { localContentStorage, objectContentStorage } from './content-storage.js';
import type { ContentStorage, ManagedContentStorage } from './content-storage.js';
import { prisma, requireAuth } from './security.js';
import { AvatarImageError, normalizeAvatarImage } from './avatar-image.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';
import { detectStoreMedia } from './store-media-routes.js';

const run = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role };
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const avatarTypes: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'] };
const reservationTtlMs = 60 * 60 * 1000;

export function registerAvatarRoutes(app: Express, storage: ManagedContentStorage | null = objectContentStorage, scanner: MalwareScanner | null = malwareScanner) {
  const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

  app.post('/api/account/avatar/uploads', uploadLimit, requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().positive() }).strict().parse(req.body);
    const extension = path.extname(input.fileName).slice(1).toLowerCase();
    if (!avatarTypes[input.contentType]?.includes(extension)) throw fail(415, 'Choose a PNG, JPEG, or WebP image with a matching file extension.');
    if (input.sizeBytes > env.CONTENT_MAX_IMAGE_BYTES) throw fail(413, 'Image exceeds the configured size limit.');
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. Your current profile photo remains active.');
    const id = crypto.randomUUID();
    const storageKey = `pending/users/${user.id}/avatars/${id}`;
    const asset = await prisma.mediaAsset.create({ data: {
      id, storageKey, originalName: input.fileName, safeName: 'profile-avatar.webp', kind: MediaKind.IMAGE,
      detectedMime: input.contentType, sizeBytes: input.sizeBytes,
      checksum: crypto.createHash('sha256').update(`pending:${id}`).digest('hex'), uploaderId: user.id,
      purpose: MediaPurpose.AVATAR, storageProvider: 'OBJECT', uploadStatus: MediaUploadStatus.PENDING,
      scanStatus: MediaScanStatus.QUARANTINED
    } });
    try {
      const upload = await storage.createUploadForm(storageKey, input.contentType, input.sizeBytes);
      res.status(201).json({ id: asset.id, upload, expiresInSeconds: 300, scanStatus: asset.scanStatus, publicAfterUpload: false });
    } catch {
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.PENDING }, data: { uploadStatus: MediaUploadStatus.FAILED } });
      throw fail(503, 'A temporary upload authorization could not be issued. Your current profile photo remains active.');
    }
  }));

  app.post('/api/account/avatar/:id/finalize', uploadLimit, requireAuth, run(async (req, res) => {
    const user = actor(res);
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. Your current profile photo remains active.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), uploaderId: user.id, purpose: MediaPurpose.AVATAR, storeId: null, storageProvider: 'OBJECT', uploadStatus: { in: [MediaUploadStatus.PENDING, MediaUploadStatus.COMPLETE] } } });
    if (!asset) throw fail(404, 'Profile photo upload not found.');
    if (asset.uploadStatus === MediaUploadStatus.COMPLETE) return res.status(asset.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ scanStatus: asset.scanStatus, scanErrorCode: asset.scanErrorCode, uploadStatus: asset.uploadStatus, publicAfterUpload: false, ...(asset.scanStatus === MediaScanStatus.APPROVED ? { avatarUrl: '/api/account/avatar' } : {}), message: 'This upload was already finalized. Its saved scan state is unchanged.' });
    if (asset.createdAt < new Date(Date.now() - reservationTtlMs)) {
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.PENDING }, data: { uploadStatus: MediaUploadStatus.FAILED } });
      await storage.remove(asset.storageKey).catch(() => undefined);
      throw fail(410, 'Upload authorization expired. Choose the image again to retry.');
    }
    const claim = await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.PENDING }, data: { uploadStatus: MediaUploadStatus.VERIFYING } });
    if (claim.count !== 1) throw fail(409, 'Upload is already being verified or is no longer available.');
    let finalKey: string | null = null;
    let persisted = false;
    try {
      const head = await storage.head(asset.storageKey);
      if (head.ContentLength !== asset.sizeBytes || head.ContentLength > env.CONTENT_MAX_IMAGE_BYTES || head.ContentType !== asset.detectedMime) throw fail(400, 'Uploaded image size or type does not match its reservation.');
      const read = await storage.readLimited(asset.storageKey, env.CONTENT_MAX_IMAGE_BYTES);
      if (read.contentLength !== asset.sizeBytes || read.bytes.length !== asset.sizeBytes || read.contentType !== asset.detectedMime) throw fail(400, 'Uploaded image metadata does not match its reservation.');
      const extension = path.extname(asset.originalName).slice(1).toLowerCase();
      const detected = detectStoreMedia(read.bytes, extension, asset.detectedMime);
      if (detected.kind !== MediaKind.IMAGE || !avatarTypes[detected.mime]?.includes(extension)) throw fail(415, 'Choose a supported PNG, JPEG, or WebP image.');
      const normalized = await normalizeAvatarImage(read.bytes, env.CONTENT_MAX_IMAGE_BYTES);
      if (normalized.bytes.length > env.CONTENT_MAX_IMAGE_BYTES) throw fail(413, 'Normalized image exceeds the configured size limit.');
      finalKey = `users/${user.id}/avatars/${asset.id}.webp`;
      await storage.put(finalKey, normalized.bytes, 'image/webp');
      const completed = await prisma.$transaction(async tx => {
        const updated = await tx.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.VERIFYING }, data: {
          storageKey: finalKey!, safeName: 'profile-avatar.webp', detectedMime: 'image/webp', sizeBytes: normalized.bytes.length,
          width: normalized.width, height: normalized.height, checksum: crypto.createHash('sha256').update(normalized.bytes).digest('hex'),
          purpose: MediaPurpose.AVATAR, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED,
          scanAttemptId: null, scanStartedAt: null, scanCompletedAt: null, scanErrorCode: null, scannerProvider: null
        } });
        if (updated.count !== 1) throw fail(409, 'Upload is no longer available.');
        await tx.auditLog.create({ data: { actorId: user.id, action: 'ACCOUNT_AVATAR_QUARANTINED', entity: 'MediaAsset', entityId: asset.id, metadata: { sizeBytes: normalized.bytes.length, scanStatus: 'QUARANTINED' } } });
      });
      persisted = true;
      void completed;
      await storage.remove(asset.storageKey).catch(() => undefined);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: normalized.bytes, scanner, actorId: user.id });
      const approved = scan.scanStatus === MediaScanStatus.APPROVED;
      return res.status(approved ? 201 : 202).json({ ...scan, uploadStatus: MediaUploadStatus.COMPLETE, publicAfterUpload: false, ...(approved ? { avatarUrl: '/api/account/avatar' } : {}), message: approved ? 'Profile photo was scanned and updated.' : scan.scanErrorCode === 'MALWARE_DETECTED' ? 'The scanner rejected this image. Your current profile photo remains active.' : 'Profile photo is stored privately and awaiting a malware scan. Your current profile photo remains active.' });
    } catch (error) {
      if (persisted) return res.status(202).json({ id: asset.id, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, publicAfterUpload: false, message: 'The image is safely stored in private quarantine, but its scan result could not be confirmed. Your current profile photo remains active; retry the scan later.' });
      if (finalKey) await storage.remove(finalKey).catch(() => undefined);
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : error instanceof AvatarImageError ? error.status : 503;
      if (status >= 400 && status < 500) {
        await storage.remove(asset.storageKey).catch(() => undefined);
        await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.VERIFYING }, data: { uploadStatus: MediaUploadStatus.FAILED } });
        throw error;
      }
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: MediaUploadStatus.VERIFYING }, data: { uploadStatus: MediaUploadStatus.PENDING } });
      throw fail(503, 'The upload could not be safely verified. Your existing profile photo remains active; retry later.');
    }
  }));

  app.post('/api/account/avatar/:id/scan-retry', uploadLimit, requireAuth, run(async (req, res) => {
    const user = actor(res);
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), uploaderId: user.id, purpose: MediaPurpose.AVATAR, storeId: null, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.QUARANTINED, storageProvider: 'OBJECT' } });
    if (!asset) throw fail(404, 'Quarantined profile photo not found.');
    if (!scanner) {
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: Buffer.alloc(0), scanner, actorId: user.id });
      return res.status(202).json({ ...scan, message: 'The malware scanner is unavailable. Your current profile photo remains active.' });
    }
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. Your current profile photo remains active.');
    try {
      const read = await storage.readLimited(asset.storageKey, env.CONTENT_MAX_IMAGE_BYTES);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: read.bytes, scanner, actorId: user.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ ...scan, ...(scan.scanStatus === MediaScanStatus.APPROVED ? { avatarUrl: '/api/account/avatar' } : {}) });
    } catch {
      return res.status(503).json({ error: 'The private profile photo could not be read for scanning. Your current photo remains active; retry later.', code: 'MEDIA_READ_UNAVAILABLE' });
    }
  }));

  app.post('/api/account/avatar', uploadLimit, requireAuth, express.raw({ type: 'application/octet-stream', limit: env.CONTENT_MAX_IMAGE_BYTES }), run(async (_req, res) => {
    res.status(410).json({ error: 'Direct avatar uploads are no longer supported. Use the short-lived private upload flow.' });
  }));

  app.get('/api/account/avatar', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { avatarMediaId: true } });
    if (!account?.avatarMediaId) return res.status(404).json({ error: 'Profile photo not found.' });
    const asset = await prisma.mediaAsset.findFirst({ where: { id: account.avatarMediaId, uploaderId: user.id, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED } });
    if (!asset) return res.status(404).json({ error: 'Profile photo not found.' });
    const source: ContentStorage | null = asset.storageProvider === 'OBJECT' ? storage : localContentStorage;
    if (!source) return res.status(503).json({ error: 'Profile photo storage is temporarily unavailable.' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Disposition', 'inline; filename="profile-avatar.webp"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, no-store');
    source.open(asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));

  app.use((error: unknown, _req: express.Request, res: Response, next: express.NextFunction) => {
    if (error instanceof AvatarImageError) return res.status(error.status).json({ error: error.message });
    if (typeof error === 'object' && error !== null && 'status' in error && (error as { status?: number }).status === 413) return res.status(413).json({ error: 'Image exceeds the configured size limit.' });
    next(error);
  });
}
