import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { MediaKind, MediaScanStatus, MediaUploadStatus, Role } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { productMediaLimitError, type ProductMediaCounts, type ProductMediaKind } from './product-media-policy.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

async function lockProductAndGetMediaCounts(tx: Prisma.TransactionClient, productId: string): Promise<ProductMediaCounts> {
  await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
  const [legacyImages, attachments] = await Promise.all([
    tx.productImage.count({ where: { productId } }),
    tx.productMedia.findMany({ where: { productId }, select: { mediaAsset: { select: { kind: true } } } })
  ]);
  const counts: ProductMediaCounts = { IMAGE: legacyImages, VIDEO: 0, DOCUMENT: 0 };
  for (const attachment of attachments) {
    if (attachment.mediaAsset.kind === MediaKind.IMAGE) counts.IMAGE += 1;
    else if (attachment.mediaAsset.kind === MediaKind.VIDEO) counts.VIDEO += 1;
    else if (attachment.mediaAsset.kind === MediaKind.DOCUMENT) counts.DOCUMENT += 1;
  }
  return counts;
}

function assertProductMediaCapacity(kind: ProductMediaKind, counts: ProductMediaCounts) {
  const limitError = productMediaLimitError(kind, counts);
  if (limitError) throw limitError;
}

export function registerProductMediaRoutes(app: Express) {
  app.post('/api/products/:id/media', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ mediaAssetId: z.string().min(1).max(100), label: z.string().trim().max(300).optional() }).strict().parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: param(req.params.id) }, select: { id: true, sellerId: true } });
    if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) throw fail(404, 'Product not found.');
    const storeId = product.sellerId ? (await prisma.store.findUnique({ where: { sellerId: product.sellerId }, select: { id: true } }))?.id : null;
    if (product.sellerId && !storeId) throw fail(409, 'Product Store scope is unavailable.');
    try {
      const attachment = await prisma.$transaction(async tx => {
        const asset = await tx.mediaAsset.findFirst({ where: {
          id: input.mediaAssetId, kind: { in: [MediaKind.IMAGE, MediaKind.VIDEO, MediaKind.DOCUMENT] }, storeId,
          uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED
        }, select: { id: true, kind: true } });
        if (!asset) throw fail(409, 'Select an approved image, video, or document owned by this Store.');
        const counts = await lockProductAndGetMediaCounts(tx, product.id);
        assertProductMediaCapacity(asset.kind as ProductMediaKind, counts);
        const position = await tx.productMedia.count({ where: { productId: product.id } });
        const created = await tx.productMedia.create({
          data: { productId: product.id, mediaAssetId: asset.id, position, label: input.label || null },
          include: { mediaAsset: { select: { id: true, originalName: true, kind: true, detectedMime: true, safeName: true, scanStatus: true, uploadStatus: true } } }
        });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCT_MEDIA_ATTACHED', entity: 'ProductMedia', entityId: created.id, metadata: { productId: product.id, mediaAssetId: asset.id, kind: created.mediaAsset.kind } } });
        return created;
      });
      res.status(201).json(attachment);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw fail(409, 'This asset is already attached to the product.');
      throw error;
    }
  }));

  app.delete('/api/products/:id/media/:attachmentId', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const product = await prisma.product.findUnique({ where: { id: param(req.params.id) }, select: { id: true, sellerId: true } });
    if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) throw fail(404, 'Product not found.');
    const attachment = await prisma.productMedia.findFirst({ where: { id: param(req.params.attachmentId), productId: product.id } });
    if (!attachment) throw fail(404, 'Product media attachment not found.');
    await prisma.$transaction(async tx => {
      await tx.productMedia.delete({ where: { id: attachment.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCT_MEDIA_DETACHED', entity: 'ProductMedia', entityId: attachment.id, metadata: { productId: product.id, mediaAssetId: attachment.mediaAssetId } } });
    });
    res.status(204).send();
  }));

  app.post('/api/products/:id/images', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ mediaAssetId: z.string().min(1).max(100), alt: z.string().trim().min(1).max(300) }).strict().parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: param(req.params.id) }, select: { id: true, sellerId: true } });
    if (!product || (user.role !== Role.ADMIN && product.sellerId !== user.sellerId)) throw fail(404, 'Product not found.');
    const storeId = product.sellerId ? (await prisma.store.findUnique({ where: { sellerId: product.sellerId }, select: { id: true } }))?.id : null;
    if (product.sellerId && !storeId) throw fail(409, 'Product Store scope is unavailable.');
    const image = await prisma.$transaction(async tx => {
      const asset = await tx.mediaAsset.findFirst({ where: {
        id: input.mediaAssetId, kind: MediaKind.IMAGE, storeId, uploadStatus: MediaUploadStatus.COMPLETE,
        scanStatus: MediaScanStatus.APPROVED
      }, select: { id: true } });
      if (!asset) throw fail(409, 'Select an approved image owned by this Store.');
      const counts = await lockProductAndGetMediaCounts(tx, product.id);
      assertProductMediaCapacity(MediaKind.IMAGE, counts);
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
