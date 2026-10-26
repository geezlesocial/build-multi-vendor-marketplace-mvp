import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ClubCoinEventType, Prisma, ProductReviewStatus, ProductStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { awardClubCoinsForEvent, reverseClubCoinsForEvent } from './club-coins-awards.js';
import { productReviewEligibility } from './product-review-domain.js';
import { currentUser, prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const reviewInput = z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().min(2).max(120), body: z.string().trim().min(10).max(3000) }).strict();
const moderationInput = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().min(3).max(1000) }).strict();

async function eligibleReceivedOrder(productId: string, userId: string, db: typeof prisma | Prisma.TransactionClient = prisma) {
  return db.sellerOrder.findFirst({
    where: {
      status: { not: 'CANCELLED' }, receivedAt: { not: null },
      parent: { is: { buyerId: userId, payment: { is: { status: 'PAID' } } } },
      items: { some: { productId } }
    },
    orderBy: { receivedAt: 'desc' },
    select: { id: true }
  });
}

export function registerProductReviewRoutes(app: Express) {
  app.get('/api/products/:productId/reviews', run(async (req, res) => {
    const productId = param(req.params.productId);
    const product = await prisma.product.findFirst({ where: { id: productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: 'APPROVED' } }] }, select: { id: true } });
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const [items, aggregate, viewer] = await Promise.all([
      prisma.productReview.findMany({ where: { productId, status: ProductReviewStatus.APPROVED }, include: { user: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
      prisma.productReview.aggregate({ where: { productId, status: ProductReviewStatus.APPROVED }, _avg: { rating: true }, _count: { _all: true } }),
      currentUser(req)
    ]);
    let eligibility = { canReview: false, reason: 'Sign in with the account used for this purchase to review.', existingReview: null as { id: string; status: ProductReviewStatus } | null };
    if (viewer) {
      const existingReview = await prisma.productReview.findUnique({ where: { productId_userId: { productId, userId: viewer.id } }, select: { id: true, status: true } });
      const eligibleOrder = viewer.emailVerifiedAt && !existingReview ? await eligibleReceivedOrder(productId, viewer.id) : null;
      const reviewEligibility = productReviewEligibility({ emailVerified: Boolean(viewer.emailVerifiedAt), alreadySubmitted: Boolean(existingReview), paidReceivedPurchase: Boolean(eligibleOrder) });
      eligibility = {
        canReview: reviewEligibility.eligible,
        reason: existingReview ? `You have already submitted a review (${existingReview.status.toLowerCase()}).` : reviewEligibility.reason,
        existingReview
      };
    }
    res.json({ averageRating: aggregate._avg.rating ?? null, reviewCount: aggregate._count._all, canReview: eligibility.canReview, reason: eligibility.reason, existingReview: eligibility.existingReview, items: items.map(review => ({ id: review.id, rating: review.rating, title: review.title, body: review.body, reviewerName: review.user.name, verifiedPurchase: review.verifiedPurchase, createdAt: review.createdAt })) });
  }));

  app.post('/api/products/:productId/reviews', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string; emailVerifiedAt?: Date | null };
    if (!user.emailVerifiedAt) throw fail(403, 'Verify your email address before submitting a product review.');
    const productId = param(req.params.productId);
    const input = reviewInput.parse(req.body);
    const product = await prisma.product.findFirst({ where: { id: productId, status: ProductStatus.APPROVED, OR: [{ sellerId: null }, { seller: { status: 'APPROVED' } }] }, select: { id: true } });
    if (!product) throw fail(404, 'Product not found.');
    let review;
    try {
      review = await prisma.$transaction(async tx => {
        const eligibleOrder = await eligibleReceivedOrder(product.id, user.id, tx);
        if (!eligibleOrder) throw fail(409, 'A paid order must be marked received before this product can be reviewed.');
        return tx.productReview.create({ data: { productId: product.id, userId: user.id, sellerOrderId: eligibleOrder.id, rating: input.rating, title: input.title, body: input.body, status: ProductReviewStatus.PENDING, verifiedPurchase: true } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'You already submitted a review for this product.');
      throw error;
    }
    res.status(201).json({ id: review.id, status: review.status, message: 'Review submitted for moderation. Reward coins are issued only if the review is approved.' });
  }));

  app.get('/api/account/product-reviews', requireAuth, run(async (_req, res) => {
    const user = res.locals.user as { id: string };
    res.json(await prisma.productReview.findMany({ where: { userId: user.id }, include: { product: { select: { id: true, name: true, slug: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }));
  }));

  app.delete('/api/account/product-reviews/:id', requireAuth, run(async (req, res) => {
    const user = res.locals.user as { id: string };
    const reviewId = param(req.params.id);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProductReview" WHERE "id" = ${reviewId} FOR UPDATE`;
      const review = await tx.productReview.findFirst({ where: { id: reviewId, userId: user.id } });
      if (!review) throw fail(404, 'Review not found.');
      if (review.status === ProductReviewStatus.REMOVED) return;
      if (review.status === ProductReviewStatus.APPROVED) await reverseClubCoinsForEvent(tx, ClubCoinEventType.REVIEW_SUBMITTED, review.id, `review-removal:${review.id}`, 'Reward reversed after the author removed the review.');
      await tx.productReview.update({ where: { id: review.id }, data: { status: ProductReviewStatus.REMOVED, moderationNote: 'Removed by author.' } });
    });
    res.json({ removed: true });
  }));

  app.get('/api/admin/product-reviews', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const status = typeof req.query.status === 'string' && Object.values(ProductReviewStatus).includes(req.query.status as ProductReviewStatus) ? req.query.status as ProductReviewStatus : ProductReviewStatus.PENDING;
    const items = await prisma.productReview.findMany({ where: { status }, include: { product: { select: { id: true, name: true, slug: true } }, user: { select: { id: true, name: true, email: true } }, sellerOrder: { select: { id: true, parent: { select: { orderNumber: true, payment: { select: { status: true } } } } } } }, orderBy: { createdAt: 'asc' }, take: 100 });
    res.json({ items, status });
  }));

  app.patch('/api/admin/product-reviews/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = res.locals.user as { id: string };
    const reviewId = param(req.params.id);
    const input = moderationInput.parse(req.body);
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProductReview" WHERE "id" = ${reviewId} FOR UPDATE`;
      const review = await tx.productReview.findUnique({ where: { id: reviewId } });
      if (!review) throw fail(404, 'Review not found.');
      if (input.decision === 'APPROVE') {
        if (review.status !== ProductReviewStatus.PENDING) throw fail(409, 'Only pending reviews can be approved.');
        const eligibleOrder = await eligibleReceivedOrder(review.productId, review.userId, tx);
        if (!eligibleOrder || eligibleOrder.id !== review.sellerOrderId || !review.verifiedPurchase) throw fail(409, 'The verified purchase no longer qualifies for review approval.');
      } else if (review.status !== ProductReviewStatus.PENDING && review.status !== ProductReviewStatus.APPROVED) {
        throw fail(409, 'This review has already been resolved.');
      }
      const status = input.decision === 'APPROVE' ? ProductReviewStatus.APPROVED : ProductReviewStatus.REJECTED;
      const next = await tx.productReview.update({ where: { id: review.id }, data: { status, moderationNote: input.reason, moderatedById: admin.id, reviewedAt: new Date() } });
      if (status === ProductReviewStatus.APPROVED) await awardClubCoinsForEvent(tx, { eventType: ClubCoinEventType.REVIEW_SUBMITTED, eventId: review.id, userId: review.userId });
      else if (review.status === ProductReviewStatus.APPROVED) await reverseClubCoinsForEvent(tx, ClubCoinEventType.REVIEW_SUBMITTED, review.id, `moderation:${review.id}`, `Reward reversed after admin review moderation: ${input.reason}`);
      await tx.auditLog.create({ data: { actorId: admin.id, action: `PRODUCT_REVIEW_${status}`, entity: 'ProductReview', entityId: review.id, metadata: { productId: review.productId, userId: review.userId, reason: input.reason } } });
      return next;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    res.json(updated);
  }));
}
