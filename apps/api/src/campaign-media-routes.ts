import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { MediaKind, MediaPurpose, MediaScanStatus, MediaStorageProvider, MediaUploadStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { localContentStorage, objectContentStorage } from './content-storage.js';
import { campaignMediaFailure, safeCampaignDestination } from './campaign-media-domain.js';
import { detectStoreMedia } from './store-media-routes.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; role: Role };
const mediaUploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 24, standardHeaders: true, legacyHeaders: false });
const safeFilenameExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', '3gp', 'mkv']);
function decodedHeader(req: Request, name: string) {
  try { return decodeURIComponent(req.get(name) ?? ''); }
  catch { throw fail(400, `The ${name.replaceAll('-', ' ')} header is invalid.`); }
}
const reasonHeader = (req: Request) => decodedHeader(req, 'x-audit-reason').trim();
const previewUrl = (campaignId: string, assetId: string) => `/api/admin/campaigns/${encodeURIComponent(campaignId)}/media/${encodeURIComponent(assetId)}/preview`;
const campaignMediaInclude = { orderBy: { position: 'asc' as const }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } };

function mediaDto(item: { campaignId: string; mediaAssetId: string; position: number; destinationUrl: string | null; altText: string | null; buttonLabel: string | null; mediaAsset: { kind: MediaKind; originalName: string; sizeBytes: number; scanStatus: MediaScanStatus; scanErrorCode: string | null; uploadStatus: MediaUploadStatus; detectedMime: string } }) {
  return { id: item.mediaAssetId, kind: item.mediaAsset.kind, position: item.position, href: item.destinationUrl, altText: item.altText, buttonLabel: item.buttonLabel, originalName: item.mediaAsset.originalName, sizeBytes: item.mediaAsset.sizeBytes, detectedMime: item.mediaAsset.detectedMime, scanStatus: item.mediaAsset.scanStatus, scanErrorCode: item.mediaAsset.scanErrorCode, uploadStatus: item.mediaAsset.uploadStatus, previewUrl: previewUrl(item.campaignId, item.mediaAssetId) };
}

function validateReason(req: Request) {
  const reason = reasonHeader(req);
  if (reason.length < 5 || reason.length > 500 || /[\r\n\0]/.test(reason)) throw fail(400, 'Enter an audit reason of 5 to 500 characters.');
  return reason;
}

function validateDestination(value: string | null) {
  if (value == null || !value.trim()) return null;
  try { return safeCampaignDestination(value); }
  catch { throw fail(400, 'Use a safe internal path or an HTTP(S) URL without embedded credentials.'); }
}

async function assertCampaign(campaignId: string) {
  const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true } });
  if (!campaign) throw fail(404, 'Promotion campaign not found.');
  if (campaign.status === 'ARCHIVED') throw fail(409, 'Archived campaigns cannot be changed.');
  return campaign;
}

export function registerCampaignMediaRoutes(app: Express, scanner: MalwareScanner | null = malwareScanner) {
  const storage = objectContentStorage ?? localContentStorage;
  const storageProvider = objectContentStorage ? MediaStorageProvider.OBJECT : MediaStorageProvider.LOCAL;

  app.post('/api/admin/campaigns/:id/media', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), mediaUploadLimiter, express.raw({ type: 'application/octet-stream', limit: env.CONTENT_MAX_VIDEO_BYTES }), run(async (req, res) => {
    const user = actor(res);
    const campaignId = z.string().cuid().parse(param(req.params.id));
    await assertCampaign(campaignId);
    const reason = validateReason(req);
    const bytesInput: unknown = req.body;
    const inputBytes = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.alloc(0);
    if (!inputBytes.length) throw fail(400, 'Choose a non-empty image or video file.');

    let originalName: string;
    originalName = decodedHeader(req, 'x-file-name').trim();
    const mime = (req.get('x-file-type') ?? '').trim().toLowerCase();
    if (!originalName || originalName.length > 255 || /[\r\n\0]/.test(originalName)) throw fail(400, 'The file name is invalid.');
    const extension = path.extname(path.basename(originalName)).slice(1).toLowerCase();
    if (!safeFilenameExtensions.has(extension)) throw fail(415, 'Choose a supported PNG, JPEG, WebP, GIF, MP4, MOV, WebM, or Ogg file.');
    let detected: ReturnType<typeof detectStoreMedia>;
    try { detected = detectStoreMedia(inputBytes, extension, mime); }
    catch { throw fail(415, 'The file content does not match a supported image or video type.'); }
    if (detected.kind !== MediaKind.IMAGE && detected.kind !== MediaKind.VIDEO) throw fail(415, 'Only image and video promotion media are supported.');
    if (detected.kind === MediaKind.IMAGE && !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) throw fail(415, 'Choose a PNG, JPEG, WebP, or GIF image.');
    if (detected.kind === MediaKind.VIDEO && !['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', '3gp', 'mkv'].includes(extension)) throw fail(415, 'Choose a supported MP4, MOV, WebM, or Ogg video.');
    const maxBytes = detected.kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : env.CONTENT_MAX_VIDEO_BYTES;
    if (inputBytes.length > maxBytes) throw fail(413, `File exceeds the configured ${detected.kind.toLowerCase()} size limit.`);

    let destinationUrl = validateDestination(decodedHeader(req, 'x-destination-url') || null);
    let altText = decodedHeader(req, 'x-alt-text').trim();
    let buttonLabel = decodedHeader(req, 'x-button-label').trim();
    if (detected.kind === MediaKind.IMAGE) {
      if (!altText || altText.length > 300 || /[<>]/.test(altText)) throw fail(400, 'Add descriptive alt text (up to 300 characters) for each image.');
      buttonLabel = '';
    } else {
      if (!buttonLabel || buttonLabel.length > 60 || /[<>]/.test(buttonLabel) || !destinationUrl) throw fail(400, 'Video promotions require a button label and a safe destination URL.');
      altText = '';
    }

    let bytes = inputBytes;
    let storedMime = detected.mime;
    let storedExtension = detected.extension;
    let width: number | null = null;
    let height: number | null = null;
    if (detected.kind === MediaKind.IMAGE) {
      try {
        const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw new Error('Unsupported image');
        width = metadata.width; height = metadata.height;
        bytes = await image.rotate().webp({ quality: 86 }).toBuffer();
        storedMime = 'image/webp'; storedExtension = 'webp';
      } catch { throw fail(415, 'The selected image could not be decoded safely.'); }
    }
    if (bytes.length > maxBytes) throw fail(413, 'Processed media exceeds the configured file-size limit.');

    const assetId = crypto.randomUUID();
    const storageKey = `platform/campaigns/${campaignId}/${assetId}.${storedExtension}`;
    await storage.put(storageKey, bytes, storedMime);
    let attached = false;
    try {
      const media = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "MarketingCampaign" WHERE "id" = ${campaignId} FOR UPDATE`;
        const campaign = await tx.marketingCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true } });
        if (!campaign) throw fail(404, 'Promotion campaign not found.');
        if (campaign.status === 'ARCHIVED') throw fail(409, 'Archived campaigns cannot be changed.');
        const existing = await tx.marketingCampaignMedia.findMany({ where: { campaignId }, include: { mediaAsset: { select: { kind: true } } } });
        const imageCount = existing.filter(item => item.mediaAsset.kind === MediaKind.IMAGE).length;
        const videoCount = existing.filter(item => item.mediaAsset.kind === MediaKind.VIDEO).length;
        if (detected.kind === MediaKind.IMAGE && imageCount >= 6) throw fail(409, 'A promotion can include up to six images. Remove an image before adding another.');
        if (detected.kind === MediaKind.VIDEO && videoCount >= 1) throw fail(409, 'A promotion can include one video maximum. Remove the existing video before adding another.');
        const position = existing.reduce((max, item) => Math.max(max, item.position), -1) + 1;
        await tx.mediaAsset.create({ data: { id: assetId, storageKey, originalName: path.basename(originalName), safeName: `${assetId}.${storedExtension}`, kind: detected.kind, detectedMime: storedMime, sizeBytes: bytes.length, width, height, checksum: crypto.createHash('sha256').update(bytes).digest('hex'), uploaderId: user.id, purpose: MediaPurpose.PLATFORM_CONTENT, uploadStatus: MediaUploadStatus.COMPLETE, storageProvider, scanStatus: MediaScanStatus.QUARANTINED } });
        const created = await tx.marketingCampaignMedia.create({ data: { campaignId, mediaAssetId: assetId, position, destinationUrl, altText: altText || null, buttonLabel: buttonLabel || null }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'MARKETING_CAMPAIGN_MEDIA_UPLOADED', entity: 'MarketingCampaignMedia', entityId: assetId, metadata: { campaignId, kind: detected.kind, reason } } });
        return created;
      });
      attached = true;
      const scan = await scanQuarantinedMedia({ assetId, bytes, scanner, actorId: user.id });
      if (scan.scanStatus === MediaScanStatus.REJECTED) {
        await prisma.marketingCampaignMedia.deleteMany({ where: { campaignId, mediaAssetId: assetId } });
        await prisma.mediaAsset.deleteMany({ where: { id: assetId, uploaderId: user.id, purpose: MediaPurpose.PLATFORM_CONTENT } });
        await storage.remove(storageKey).catch(() => undefined);
        throw fail(422, 'The safety scanner rejected this file. It was removed and cannot be published.');
      }
      const updated = await prisma.marketingCampaignMedia.findUniqueOrThrow({ where: { campaignId_mediaAssetId: { campaignId, mediaAssetId: assetId } }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 201 : 202).json({ media: mediaDto(updated), message: scan.scanStatus === MediaScanStatus.APPROVED ? 'Media uploaded, normalized, and safety-approved.' : 'Media is saved privately while its safety scan completes. It will not be shown publicly until approved.' });
    } catch (error) {
      if (!attached) await storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }));

  app.patch('/api/admin/campaigns/:id/media/:assetId', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const user = actor(res);
    const campaignId = z.string().cuid().parse(param(req.params.id));
    const mediaAssetId = z.string().uuid().parse(param(req.params.assetId));
    await assertCampaign(campaignId);
    const reason = z.string().trim().min(5).max(500).parse(req.body.reason);
    const existing = await prisma.marketingCampaignMedia.findUnique({ where: { campaignId_mediaAssetId: { campaignId, mediaAssetId } }, include: { mediaAsset: { select: { kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } });
    if (!existing) throw fail(404, 'Campaign media was not found.');
    const input = z.object({ href: z.string().trim().max(2000).nullable().optional(), altText: z.string().trim().max(300).nullable().optional(), buttonLabel: z.string().trim().max(60).nullable().optional(), reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    const destinationUrl = input.href === undefined ? existing.destinationUrl : validateDestination(input.href);
    const altText = input.altText === undefined ? existing.altText : input.altText;
    const buttonLabel = input.buttonLabel === undefined ? existing.buttonLabel : input.buttonLabel;
    if (existing.mediaAsset.kind === MediaKind.IMAGE && (!altText?.trim() || /[<>]/.test(altText))) throw fail(400, 'Image alt text is required and must not contain markup.');
    if (existing.mediaAsset.kind === MediaKind.VIDEO && (buttonLabel && /[<>]/.test(buttonLabel))) throw fail(400, 'Video button text must not contain markup.');
    const updated = await prisma.marketingCampaignMedia.update({ where: { campaignId_mediaAssetId: { campaignId, mediaAssetId } }, data: { destinationUrl, altText, buttonLabel }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } });
    await audit(user.id, 'MARKETING_CAMPAIGN_MEDIA_UPDATED', 'MarketingCampaignMedia', mediaAssetId, { campaignId, reason });
    res.json(mediaDto(updated));
  }));

  app.delete('/api/admin/campaigns/:id/media/:assetId', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const user = actor(res);
    const campaignId = z.string().cuid().parse(param(req.params.id));
    const mediaAssetId = z.string().uuid().parse(param(req.params.assetId));
    await assertCampaign(campaignId);
    const reason = validateReason(req);
    const removed = await prisma.marketingCampaignMedia.deleteMany({ where: { campaignId, mediaAssetId } });
    if (!removed.count) throw fail(404, 'Campaign media was not found.');
    await audit(user.id, 'MARKETING_CAMPAIGN_MEDIA_REMOVED', 'MarketingCampaignMedia', mediaAssetId, { campaignId, reason });
    // Keep the media asset itself: the shared content library may also reference it.
    res.status(204).send();
  }));

  app.post('/api/admin/campaigns/:id/media/:assetId/scan-retry', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const user = actor(res);
    const campaignId = z.string().cuid().parse(param(req.params.id));
    const mediaAssetId = z.string().uuid().parse(param(req.params.assetId));
    const reason = z.string().trim().min(5).max(500).parse(req.body.reason);
    const asset = await prisma.mediaAsset.findFirst({ where: { id: mediaAssetId, purpose: MediaPurpose.PLATFORM_CONTENT, uploadStatus: MediaUploadStatus.COMPLETE, marketingCampaignMedia: { some: { campaignId } } } });
    if (!asset) throw fail(404, 'Campaign media was not found.');
    if (asset.scanStatus !== MediaScanStatus.QUARANTINED) throw fail(409, 'Only media awaiting a safety scan can be retried.');
    const maxBytes = asset.kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : env.CONTENT_MAX_VIDEO_BYTES;
    try {
      const read = await storage.readLimited(asset.storageKey, maxBytes);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: read.bytes, scanner, actorId: user.id });
      await audit(user.id, 'MARKETING_CAMPAIGN_MEDIA_SCAN_RETRIED', 'MarketingCampaignMedia', mediaAssetId, { campaignId, result: scan.scanStatus, reason });
      if (scan.scanStatus === MediaScanStatus.REJECTED) {
        await prisma.marketingCampaignMedia.deleteMany({ where: { campaignId, mediaAssetId } });
        await prisma.mediaAsset.deleteMany({ where: { id: asset.id, uploaderId: asset.uploaderId, purpose: MediaPurpose.PLATFORM_CONTENT } });
        await storage.remove(asset.storageKey).catch(() => undefined);
        return res.status(422).json({ error: 'The safety scanner rejected this file. It was removed.' });
      }
      const updated = await prisma.marketingCampaignMedia.findUniqueOrThrow({ where: { campaignId_mediaAssetId: { campaignId, mediaAssetId } }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true, detectedMime: true } } } });
      res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ media: mediaDto(updated), message: scan.scanStatus === MediaScanStatus.APPROVED ? 'Safety scan approved this media.' : 'The media remains private while the scanner is unavailable.' });
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) throw error;
      throw fail(503, 'The private media file could not be checked. It remains unavailable publicly; retry later.');
    }
  }));

  app.get('/api/admin/campaigns/:id/media/:assetId/preview', requireAuth, requireRole(Role.ADMIN, Role.CONTENT_EDITOR), run(async (req, res) => {
    const campaignId = z.string().cuid().parse(param(req.params.id));
    const mediaAssetId = z.string().uuid().parse(param(req.params.assetId));
    const item = await prisma.marketingCampaignMedia.findUnique({ where: { campaignId_mediaAssetId: { campaignId, mediaAssetId } }, include: { mediaAsset: { select: { storageKey: true, storageProvider: true, detectedMime: true, safeName: true, uploadStatus: true, scanStatus: true } } } });
    if (!item || item.mediaAsset.uploadStatus !== MediaUploadStatus.COMPLETE || item.mediaAsset.scanStatus === MediaScanStatus.REJECTED) return res.status(404).send('Promotion preview unavailable.');
    const size = (await prisma.mediaAsset.findUnique({ where: { id: mediaAssetId }, select: { sizeBytes: true } }))?.sizeBytes;
    const range = req.headers.range;
    if (range && item.mediaAsset.detectedMime.startsWith('video/') && size != null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : match[2] && !match[1] ? size - 1 : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set({ 'Content-Type': item.mediaAsset.detectedMime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
      storage.open(item.mediaAsset.storageKey, { start, end }).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
      return;
    }
    res.set({ 'Content-Type': item.mediaAsset.detectedMime, 'Content-Disposition': `inline; filename="${item.mediaAsset.safeName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', ...(item.mediaAsset.detectedMime.startsWith('video/') ? { 'Accept-Ranges': 'bytes' } : {}) });
    storage.open(item.mediaAsset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));
}
