import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { MediaKind, MediaPurpose, MediaScanStatus, MediaUploadStatus, MessageReactionKind, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { env } from './config.js';
import { localContentStorage, objectContentStorage } from './content-storage.js';
import type { ContentStorage } from './content-storage.js';
import { detectStoreMedia } from './store-media-routes.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';
import { prisma, requireAuth } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const reactionKinds = Object.values(MessageReactionKind);
const supportedImages: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'] };
const supportedVideos: Record<string, string[]> = { 'video/mp4': ['mp4', 'm4v'], 'video/quicktime': ['mov'], 'video/webm': ['webm'], 'video/ogg': ['ogv', 'ogg'] };
const storage: ContentStorage | null = objectContentStorage ?? (env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? localContentStorage : null);
const scanner: MalwareScanner | null = malwareScanner;
const attachmentRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

type Actor = { id: string; sellerId?: string };
function actor(res: Response): Actor { return res.locals.user as Actor; }
function canAccessWhere(user: Actor): Prisma.ConversationWhereInput {
  return { OR: [{ buyerId: user.id }, { directRecipientId: user.id }, ...(user.sellerId ? [{ sellerId: user.sellerId }] : [])] };
}
async function accessibleConversation(conversationId: string, user: Actor, openOnly = false) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, ...(openOnly ? { status: 'OPEN' as const } : {}), ...canAccessWhere(user) },
    select: { id: true, status: true }
  });
}

async function messageResult(messageId: string, userId: string) {
  const [groups, selected] = await Promise.all([
    prisma.messageReaction.groupBy({ by: ['reaction'], where: { messageId }, _count: { _all: true } }),
    prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId, userId } }, select: { reaction: true } })
  ]);
  const reactions = Object.fromEntries(reactionKinds.map(kind => [kind, 0])) as Record<MessageReactionKind, number>;
  for (const group of groups) reactions[group.reaction] = group._count._all;
  return { reactions, myReaction: selected?.reaction ?? null };
}

function uploadParser(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: 'application/octet-stream', limit: env.CONTENT_MAX_VIDEO_BYTES })(req, res, error => {
    if (!error) return next();
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: number }).status) : 400;
    return res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? 'File exceeds the configured upload limit.' : 'The upload could not be read.' });
  });
}

async function readPrivateObject(source: ContentStorage, key: string, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source.open(key)) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) throw fail(413, 'Private media exceeds its stored size limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function maxBytes(kind: MediaKind) {
  return kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : env.CONTENT_MAX_VIDEO_BYTES;
}

export function registerMessageRoutes(app: Express) {
  app.post('/api/messages/:id/read', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const messageId = param(req.params.id);
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true, senderId: true } });
    if (!message || !await accessibleConversation(message.conversationId, user)) return res.status(404).json({ error: 'Message not found.' });
    if (message.senderId === user.id) return res.json({ markedRead: 0 });
    const result = await prisma.message.updateMany({
      where: { id: message.id, conversationId: message.conversationId, senderId: { not: user.id }, readAt: null },
      data: { readAt: new Date() }
    });
    res.json({ markedRead: result.count });
  }));

  app.post('/api/conversations/:id/read', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const result = await prisma.message.updateMany({
      where: { conversationId: conversation.id, senderId: { not: user.id }, readAt: null },
      data: { readAt: new Date() }
    });
    res.json({ markedRead: result.count });
  }));

  app.get('/api/conversations/:id/messages', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { sentAt: 'asc' },
      take: 200,
      include: {
        sender: { select: { id: true, name: true } },
        attachments: { where: { conversationId: conversation.id }, include: { mediaAsset: { select: { id: true, kind: true, originalName: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, uploadStatus: true } } } }
      }
    });
    const ids = rows.map(row => row.id);
    const [groups, mine] = ids.length ? await Promise.all([
      prisma.messageReaction.groupBy({ by: ['messageId', 'reaction'], where: { messageId: { in: ids } }, _count: { _all: true } }),
      prisma.messageReaction.findMany({ where: { messageId: { in: ids }, userId: user.id }, select: { messageId: true, reaction: true } })
    ]) : [[], []];
    const counts = new Map<string, Record<MessageReactionKind, number>>();
    for (const group of groups) {
      const values = counts.get(group.messageId) ?? Object.fromEntries(reactionKinds.map(kind => [kind, 0])) as Record<MessageReactionKind, number>;
      values[group.reaction] = group._count._all;
      counts.set(group.messageId, values);
    }
    const mineByMessage = new Map(mine.map(item => [item.messageId, item.reaction]));
    res.set('Cache-Control', 'private, no-store');
    res.json(rows.map(({ attachments, ...message }) => ({
      ...message,
      attachments: attachments.map(({ mediaAsset }) => ({
        id: mediaAsset.id,
        kind: mediaAsset.kind,
        originalName: mediaAsset.originalName,
        sizeBytes: mediaAsset.sizeBytes,
        scanStatus: mediaAsset.scanStatus,
        scanErrorCode: mediaAsset.scanErrorCode,
        uploadStatus: mediaAsset.uploadStatus,
        url: mediaAsset.scanStatus === MediaScanStatus.APPROVED && mediaAsset.uploadStatus === MediaUploadStatus.COMPLETE
          ? `/api/conversations/${encodeURIComponent(conversation.id)}/attachments/${encodeURIComponent(mediaAsset.id)}`
          : null
      })),
      reactions: counts.get(message.id) ?? Object.fromEntries(reactionKinds.map(kind => [kind, 0])),
      myReaction: mineByMessage.get(message.id) ?? null
    })));
  }));

  app.post('/api/conversations/:id/messages', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ body: z.string().trim().max(4000).optional(), attachmentIds: z.array(z.string().min(1).max(100)).max(5).default([]) }).strict().parse(req.body);
    const body = input.body?.trim() ?? '';
    if (!body && !input.attachmentIds.length) throw fail(400, 'Write a message or attach at least one image or video.');
    if (new Set(input.attachmentIds).size !== input.attachmentIds.length) throw fail(400, 'The same attachment cannot be added twice.');
    const conversation = await accessibleConversation(param(req.params.id), user, true);
    if (!conversation) return res.status(404).json({ error: 'Open conversation not found.' });
    if (input.attachmentIds.length) {
      const attachments = await prisma.messageAttachment.findMany({
        where: { id: { in: input.attachmentIds }, conversationId: conversation.id, senderId: user.id, messageId: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        include: { mediaAsset: { select: { purpose: true, uploadStatus: true, scanStatus: true } } }
      });
      if (attachments.length !== input.attachmentIds.length || attachments.some(item => item.mediaAsset.purpose !== MediaPurpose.MESSAGE || item.mediaAsset.uploadStatus !== MediaUploadStatus.COMPLETE || item.mediaAsset.scanStatus === MediaScanStatus.REJECTED)) {
        throw fail(400, 'One or more attachments are no longer available to send. Remove them and choose the files again.');
      }
    }
    const message = await prisma.$transaction(async tx => {
      const created = await tx.message.create({ data: { conversationId: conversation.id, senderId: user.id, body } });
      if (input.attachmentIds.length) {
        const linked = await tx.messageAttachment.updateMany({ where: { id: { in: input.attachmentIds }, conversationId: conversation.id, senderId: user.id, messageId: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, data: { messageId: created.id, expiresAt: null } });
        if (linked.count !== input.attachmentIds.length) throw fail(409, 'An attachment was already sent. Refresh the conversation and try again.');
      }
      await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      return created;
    });
    res.status(201).json(message);
  }));

  app.put('/api/conversations/:conversationId/messages/:messageId/reaction', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ reaction: z.nativeEnum(MessageReactionKind).nullable() }).strict().parse(req.body);
    const conversation = await accessibleConversation(param(req.params.conversationId), user);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const messageId = param(req.params.messageId);
    const message = await prisma.message.findFirst({ where: { id: messageId, conversationId: conversation.id }, select: { id: true } });
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (input.reaction) {
      await prisma.messageReaction.upsert({
        where: { messageId_userId: { messageId, userId: user.id } },
        update: { reaction: input.reaction },
        create: { messageId, userId: user.id, reaction: input.reaction }
      });
    } else {
      await prisma.messageReaction.deleteMany({ where: { messageId, userId: user.id } });
    }
    res.json({ messageId, ...(await messageResult(messageId, user.id)) });
  }));

  app.post('/api/conversations/:id/attachments', attachmentRateLimit, requireAuth, uploadParser, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user, true);
    if (!conversation) return res.status(404).json({ error: 'Open conversation not found.' });
    if (!storage) throw fail(503, 'Private message attachments are not configured for this deployment.');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw fail(400, 'Choose a non-empty image or video.');
    let originalName: string;
    try { originalName = decodeURIComponent(req.get('x-file-name') ?? '').trim(); }
    catch { throw fail(400, 'The file name is invalid.'); }
    const claimedMime = (req.get('x-file-type') ?? '').trim().toLowerCase();
    if (!originalName || originalName.length > 255 || /[\r\n\0]/.test(originalName)) throw fail(400, 'The file name is invalid.');
    const extension = path.extname(path.basename(originalName)).slice(1).toLowerCase();
    const imageExtensions = supportedImages[claimedMime];
    const videoExtensions = supportedVideos[claimedMime];
    if (!imageExtensions?.includes(extension) && !videoExtensions?.includes(extension)) throw fail(415, 'Choose a PNG, JPEG, WebP, GIF, MP4, MOV, WebM, or Ogg media file.');
    const detected = detectStoreMedia(req.body, extension, claimedMime);
    if (detected.kind !== MediaKind.IMAGE && detected.kind !== MediaKind.VIDEO) throw fail(415, 'Only images and videos can be attached to messages.');
    const limit = maxBytes(detected.kind);
    if (req.body.length > limit) throw fail(413, `This ${detected.kind.toLowerCase()} exceeds the configured size limit.`);

    let bytes = req.body;
    let mime = detected.mime;
    let ext = detected.extension;
    let width: number | undefined;
    let height: number | undefined;
    if (detected.kind === MediaKind.IMAGE) {
      try {
        const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw fail(415, 'The selected image could not be decoded safely.');
        width = metadata.width;
        height = metadata.height;
        bytes = await image.rotate().webp({ quality: 86 }).toBuffer();
        mime = 'image/webp';
        ext = 'webp';
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'statusCode' in error) throw error;
        throw fail(415, 'The selected image could not be decoded safely.');
      }
      if (bytes.length > env.CONTENT_MAX_IMAGE_BYTES) throw fail(413, 'The processed image exceeds the configured size limit.');
    }

    const id = crypto.randomUUID();
    const storageKey = `messages/${conversation.id}/${id}.${ext}`;
    const safeName = `${path.parse(originalName).name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 90) || 'attachment'}.${ext}`;
    let stored = false;
    let persisted = false;
    let attachmentId: string | null = null;
    try {
      await storage.put(storageKey, bytes, mime);
      stored = true;
      const created = await prisma.$transaction(async tx => {
        const asset = await tx.mediaAsset.create({ data: {
          id, storageKey, originalName: path.basename(originalName), safeName, kind: detected.kind, detectedMime: mime,
          sizeBytes: bytes.length, width: width ?? null, height: height ?? null,
          checksum: crypto.createHash('sha256').update(bytes).digest('hex'), uploaderId: user.id,
          purpose: MediaPurpose.MESSAGE, uploadStatus: MediaUploadStatus.COMPLETE,
          storageProvider: objectContentStorage ? 'OBJECT' : 'LOCAL', scanStatus: MediaScanStatus.QUARANTINED
        } });
        const attachment = await tx.messageAttachment.create({ data: { conversationId: conversation.id, senderId: user.id, mediaAssetId: asset.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'MESSAGE_ATTACHMENT_QUARANTINED', entity: 'MediaAsset', entityId: asset.id, metadata: { conversationId: conversation.id, kind: detected.kind, sizeBytes: bytes.length } } });
        return { asset, attachment };
      });
      persisted = true;
      attachmentId = created.attachment.id;
      const scan = await scanQuarantinedMedia({ assetId: created.asset.id, bytes, scanner, actorId: user.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 201 : 202).json({
        id: created.attachment.id, assetId: created.asset.id, kind: created.asset.kind, originalName: created.asset.originalName,
        sizeBytes: created.asset.sizeBytes, scanStatus: scan.scanStatus,
        message: scan.scanStatus === MediaScanStatus.APPROVED ? 'File is scanned and ready to send.' : 'File is uploaded privately and will appear in the conversation only after the safety scan approves it.'
      });
    } catch (error) {
      if (stored && !persisted) await storage.remove(storageKey).catch(() => undefined);
      if (persisted) return res.status(202).json({ id: attachmentId, assetId: id, kind: detected.kind, originalName: path.basename(originalName), sizeBytes: bytes.length, scanStatus: MediaScanStatus.QUARANTINED, message: 'File is stored privately but its safety scan could not be confirmed yet.' });
      throw error;
    }
  }));

  app.delete('/api/conversations/:id/attachments/:attachmentId', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user, true);
    if (!conversation) return res.status(404).json({ error: 'Open conversation not found.' });
    const attachment = await prisma.messageAttachment.findFirst({
      where: { id: param(req.params.attachmentId), conversationId: conversation.id, senderId: user.id, messageId: null },
      include: { mediaAsset: { select: { id: true, storageKey: true, storageProvider: true, purpose: true } } }
    });
    if (!attachment || attachment.mediaAsset.purpose !== MediaPurpose.MESSAGE) return res.status(404).json({ error: 'Unsent attachment not found.' });
    const deleted = await prisma.$transaction(async tx => {
      const removed = await tx.messageAttachment.deleteMany({ where: { id: attachment.id, senderId: user.id, messageId: null } });
      if (removed.count === 1) await tx.mediaAsset.deleteMany({ where: { id: attachment.mediaAsset.id, uploaderId: user.id, purpose: MediaPurpose.MESSAGE } });
      return removed.count;
    });
    if (!deleted) return res.status(409).json({ error: 'This attachment has already been sent and can no longer be removed from the draft.' });
    const source = attachment.mediaAsset.storageProvider === 'OBJECT' ? objectContentStorage : localContentStorage;
    await source?.remove(attachment.mediaAsset.storageKey).catch(() => undefined);
    res.status(204).send();
  }));

  app.post('/api/conversations/:id/attachments/:assetId/scan-retry', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    const link = await prisma.messageAttachment.findFirst({
      where: { conversationId: conversation.id, senderId: user.id, mediaAssetId: param(req.params.assetId), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { mediaAsset: true }
    });
    if (!link || link.mediaAsset.purpose !== MediaPurpose.MESSAGE || link.mediaAsset.uploadStatus !== MediaUploadStatus.COMPLETE || link.mediaAsset.scanStatus !== MediaScanStatus.QUARANTINED) return res.status(404).json({ error: 'Quarantined attachment not found.' });
    if (!scanner) return res.status(202).json({ scanStatus: MediaScanStatus.QUARANTINED, message: 'The configured malware scanner is not available; the file remains private.' });
    const source = link.mediaAsset.storageProvider === 'OBJECT' ? objectContentStorage : localContentStorage;
    if (!source) throw fail(503, 'Private attachment storage is unavailable.');
    try {
      const bytes = await readPrivateObject(source, link.mediaAsset.storageKey, maxBytes(link.mediaAsset.kind));
      const result = await scanQuarantinedMedia({ assetId: link.mediaAsset.id, bytes, scanner, actorId: user.id });
      res.status(result.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json(result);
    } catch {
      throw fail(503, 'The private attachment could not be scanned; it remains unavailable in the thread.');
    }
  }));

  app.get('/api/conversations/:id/attachments/:assetId', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const conversation = await accessibleConversation(param(req.params.id), user);
    if (!conversation) return res.status(404).json({ error: 'Attachment not found.' });
    const attachment = await prisma.messageAttachment.findFirst({
      where: { conversationId: conversation.id, mediaAssetId: param(req.params.assetId), messageId: { not: null } },
      include: { mediaAsset: true }
    });
    const asset = attachment?.mediaAsset;
    if (!asset || asset.purpose !== MediaPurpose.MESSAGE || asset.uploadStatus !== MediaUploadStatus.COMPLETE || asset.scanStatus !== MediaScanStatus.APPROVED) return res.status(404).json({ error: 'Attachment not found.' });
    const source = asset.storageProvider === 'OBJECT' ? objectContentStorage : localContentStorage;
    if (!source) throw fail(503, 'Private attachment storage is unavailable.');
    res.set({
      'Content-Type': asset.detectedMime,
      'Content-Disposition': `inline; filename="${asset.safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store'
    });
    source.open(asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));
}

export async function purgeExpiredMessageAttachmentDrafts(now = new Date()) {
  const stale = await prisma.messageAttachment.findMany({
    where: { messageId: null, expiresAt: { lte: now } },
    include: { mediaAsset: { select: { id: true, storageKey: true, storageProvider: true, uploaderId: true, purpose: true } } },
    orderBy: { expiresAt: 'asc' },
    take: 100
  });
  let removed = 0;
  for (const draft of stale) {
    const deleted = await prisma.$transaction(async tx => {
      const link = await tx.messageAttachment.deleteMany({ where: { id: draft.id, messageId: null, expiresAt: { lte: now } } });
      if (link.count === 1 && draft.mediaAsset.purpose === MediaPurpose.MESSAGE) {
        await tx.mediaAsset.deleteMany({ where: { id: draft.mediaAsset.id, uploaderId: draft.mediaAsset.uploaderId, purpose: MediaPurpose.MESSAGE } });
      }
      return link.count;
    });
    if (deleted && draft.mediaAsset.purpose === MediaPurpose.MESSAGE) {
      const source = draft.mediaAsset.storageProvider === 'OBJECT' ? objectContentStorage : localContentStorage;
      await source?.remove(draft.mediaAsset.storageKey).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
