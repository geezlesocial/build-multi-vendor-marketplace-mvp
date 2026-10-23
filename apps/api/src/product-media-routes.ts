import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { MediaKind, MediaScanStatus, MediaUploadStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { audit, prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

export function registerProductMediaRoutes(app: Express) {
  app.post('/api/products/:id/images', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ mediaAssetId: z.string().min(1).max(100), alt: z.string().trim().min(1).max(300) }).strict().parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: param(req.params.id) }, select: { id: true, sellerId: true } });
    if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) throw fail(404, 'Product not found.');
    const storeId = product.sellerId ? (await prisma.store.findUnique({ where: { sellerId: product.sellerId }, select: { id: true } }))?.id : null;
    if (product.sellerId && !storeId) throw fail(409, 'Product Store scope is unavailable.');
    const asset = await prisma.mediaAsset.findFirst({ where: {
      id: input.mediaAssetId, kind: MediaKind.IMAGE, storeId, uploadStatus: MediaUploadStatus.COMPLETE,
      scanStatus: MediaScanStatus.APPROVED
    }, select: { id: true } });
    if (!asset) throw fail(409, 'Select an approved image owned by this Store.');
    const image = await prisma.$transaction(async tx => {
      const created = await tx.productImage.create({ data: { productId: product.id, mediaAssetId: asset.id, url: `/content-media/${encodeURIComponent(asset.id)}`, alt: input.alt } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCT_MEDIA_ATTACHED', entity: 'ProductImage', entityId: created.id, metadata: { productId: product.id, mediaAssetId: asset.id } } });
      return created;
    });
    res.status(201).json(image);
  }));

  app.delete('/api/products/:id/images/:imageId', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const product = await prisma.product.findUnique({ where: { id: param(req.params.id) }, select: { id: true, sellerId: true } });
    if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) throw fail(404, 'Product not found.');
    const image = await prisma.productImage.findFirst({ where: { id: param(req.params.imageId), productId: product.id } });
    if (!image) throw fail(404, 'Product image not found.');
    await prisma.$transaction(async tx => {
      await tx.productImage.delete({ where: { id: image.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCT_MEDIA_DETACHED', entity: 'ProductImage', entityId: image.id, metadata: { productId: product.id, mediaAssetId: image.mediaAssetId } } });
    });
    res.status(204).send();
  }));
}
