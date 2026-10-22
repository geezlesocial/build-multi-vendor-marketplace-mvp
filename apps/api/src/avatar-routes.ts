import crypto from 'node:crypto';
import express, { type Express, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { MediaKind, MediaScanStatus, Role } from '@prisma/client';
import { env } from './config.js';
import { contentStorage } from './content-storage.js';
import { prisma, requireAuth } from './security.js';
import { AvatarImageError, normalizeAvatarImage } from './avatar-image.js';

const run = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role };

export function registerAvatarRoutes(app: Express) {
  const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

  app.post('/api/account/avatar', uploadLimit, requireAuth, express.raw({ type: 'application/octet-stream', limit: env.CONTENT_MAX_IMAGE_BYTES }), run(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Image bytes are required.' });
    const image = await normalizeAvatarImage(req.body, env.CONTENT_MAX_IMAGE_BYTES);
    const user = actor(res);
    const scanStatus = env.NODE_ENV === 'production' || env.CONTENT_SCAN_REQUIRED ? MediaScanStatus.QUARANTINED : MediaScanStatus.APPROVED;
    const storageKey = `${crypto.randomUUID()}.webp`;
    await contentStorage.put(storageKey, image.bytes);
    try {
      const asset = await prisma.$transaction(async tx => {
        const created = await tx.mediaAsset.create({ data: {
          storageKey,
          originalName: 'profile-avatar.webp',
          safeName: 'profile-avatar.webp',
          kind: MediaKind.IMAGE,
          detectedMime: 'image/webp',
          sizeBytes: image.bytes.length,
          width: image.width,
          height: image.height,
          checksum: crypto.createHash('sha256').update(image.bytes).digest('hex'),
          uploaderId: user.id,
          altText: `${user.id}'s profile photo`,
          scanStatus
        } });
        if (scanStatus === MediaScanStatus.APPROVED) await tx.user.update({ where: { id: user.id }, data: { avatarMediaId: created.id } });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'ACCOUNT_AVATAR_UPLOADED', entity: 'MediaAsset', entityId: created.id, metadata: { scanStatus, sizeBytes: image.bytes.length } } });
        return created;
      });
      if (asset.scanStatus !== MediaScanStatus.APPROVED) return res.status(202).json({ scanStatus: asset.scanStatus, message: 'Your photo is stored safely and is awaiting the required security scan. Your current profile image remains in place.' });
      res.status(201).json({ scanStatus: asset.scanStatus, avatarUrl: '/api/account/avatar' });
    } catch (error) {
      await contentStorage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }));

  app.get('/api/account/avatar', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { avatarMediaId: true } });
    if (!account?.avatarMediaId) return res.status(404).json({ error: 'Profile photo not found.' });
    const asset = await prisma.mediaAsset.findFirst({ where: { id: account.avatarMediaId, uploaderId: user.id, kind: MediaKind.IMAGE, scanStatus: MediaScanStatus.APPROVED } });
    if (!asset) return res.status(404).json({ error: 'Profile photo not found.' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Disposition', 'inline; filename="profile-avatar.webp"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, no-store');
    contentStorage.open(asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
  }));

  app.use((error: unknown, _req: express.Request, res: Response, next: express.NextFunction) => {
    if (error instanceof AvatarImageError) return res.status(error.status).json({ error: error.message });
    if (typeof error === 'object' && error !== null && 'status' in error && (error as { status?: number }).status === 413) return res.status(413).json({ error: 'Image exceeds the configured size limit.' });
    next(error);
  });
}
