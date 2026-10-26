import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { OrderStatus, PaymentMethod, PaymentStatus, Role, ShipmentStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { shipmentTransitionAllowed } from './shipment-domain.js';
import { carrierTrackingUrl } from './carrier-domain.js';
import { awardClubCoinsForCompletedOrder } from './club-coins-awards.js';
import { createUserNotification } from './notification-delivery.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
const optionalText = (maximum: number) => z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().trim().min(1).max(maximum).optional());
const shipmentUpdateSchema = z.object({
  status: z.nativeEnum(ShipmentStatus),
  carrier: optionalText(120),
  trackingNumber: optionalText(160),
  trackingUrl: z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value,
    z.string().trim().url().max(2000).refine(value => new URL(value).protocol === 'https:', 'Tracking URL must use HTTPS').optional()),
  note: optionalText(500)
}).strict();
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };

export function registerOrderShippingRoutes(app: Express) {
  app.patch('/api/sellers/:sellerId/orders/:orderId/shipping', requireAuth, requireRole(Role.SELLER, Role.CASHIER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const input = shipmentUpdateSchema.parse(req.body);
    const sellerId = user.role === Role.ADMIN ? param(req.params.sellerId) : user.sellerId;
    const orderId = param(req.params.orderId);
    if (!sellerId) throw fail(403, 'Seller scope is required.');
    const initial = await prisma.sellerOrder.findFirst({ where: { id: orderId, sellerId }, select: { id: true, parentId: true } });
    if (!initial) throw fail(404, 'Seller order not found.');

    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.id} FOR UPDATE`;
      const current = await tx.sellerOrder.findUnique({ where: { id: initial.id }, include: { parent: { include: { payment: true } }, seller: { include: { store: true } } } });
      if (!current?.seller) throw fail(404, 'Seller order not found.');
      if (current.status === OrderStatus.CANCELLED || current.parent.status === OrderStatus.CANCELLED) throw fail(409, 'Cancelled orders cannot be shipped.');
      if (current.receivedAt) throw fail(409, 'Shipment details are locked after the buyer confirms receipt.');
      if (current.parent.payment?.method === PaymentMethod.POS) throw fail(409, 'In-person POS sales do not use shipment tracking.');
      if (!current.parent.payment || (current.parent.payment.method !== PaymentMethod.COD && current.parent.payment.status !== PaymentStatus.PAID)) throw fail(409, 'Online payment must be confirmed before this order can ship.');
      if (current.parent.payment.status !== PaymentStatus.PAID && !(current.parent.payment.method === PaymentMethod.COD && current.parent.payment.status === PaymentStatus.PENDING)) throw fail(409, 'This payment is not eligible for shipment.');
      if (!shipmentTransitionAllowed(current.shipmentStatus, input.status)) throw fail(409, `Shipment cannot move from ${current.shipmentStatus ?? 'not shipped'} to ${input.status}.`, 'INVALID_SHIPMENT_TRANSITION');

      const shippingSnapshot = current.shippingSnapshotJson && typeof current.shippingSnapshotJson === 'object' && !Array.isArray(current.shippingSnapshotJson)
        ? current.shippingSnapshotJson as Record<string, unknown> : {};
      const savedCarrierName = typeof shippingSnapshot.carrierProviderName === 'string' ? shippingSnapshot.carrierProviderName : null;
      const trackingTemplate = typeof shippingSnapshot.trackingUrlTemplate === 'string' ? shippingSnapshot.trackingUrlTemplate : null;
      const carrier = input.carrier ?? current.shippingCarrier ?? savedCarrierName;
      const trackingNumber = input.trackingNumber ?? current.trackingNumber;
      const trackingUrl = input.trackingUrl ?? carrierTrackingUrl(trackingTemplate, trackingNumber) ?? current.trackingUrl;
      if (!carrier || (!trackingNumber && !trackingUrl)) throw fail(400, 'Enter a carrier and either a tracking number or tracking URL before saving shipment progress.');
      const note = input.note ?? null;
      const unchanged = current.shipmentStatus === input.status && current.shippingCarrier === carrier && current.trackingNumber === trackingNumber && current.trackingUrl === trackingUrl && !note;
      if (unchanged) return { current, changed: false };

      const now = new Date();
      const updated = await tx.sellerOrder.update({ where: { id: current.id }, data: {
        shipmentStatus: input.status,
        shippingCarrier: carrier,
        trackingNumber,
        trackingUrl,
        shippedAt: current.shippedAt ?? now,
        deliveredAt: input.status === ShipmentStatus.DELIVERED ? current.deliveredAt ?? now : current.deliveredAt,
        ...(input.status === ShipmentStatus.DELIVERED ? { status: OrderStatus.FULFILLED } : current.status === OrderStatus.PENDING ? { status: OrderStatus.PROCESSING } : {})
      } });
      await tx.shipmentUpdate.create({ data: { sellerOrderId: current.id, status: input.status, carrier, trackingNumber, trackingUrl, note, createdById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SELLER_SHIPMENT_UPDATED', entity: 'SellerOrder', entityId: current.id, metadata: { status: input.status, carrier, trackingNumber, trackingUrl, note } } });
      if (current.parent.buyerId) await createUserNotification(tx, {
        userId: current.parent.buyerId, eventType: 'ORDER_SHIPMENT_UPDATED', title: 'Shipping progress updated',
        body: `${current.seller.store?.name ?? 'A Store'}: your order is ${input.status.toLowerCase().replaceAll('_', ' ')}.`,
        link: '/dashboard?tab=orders', payloadJson: { parentOrderId: current.parentId, sellerOrderId: current.id, shipmentStatus: input.status }
      }, 'orders');
      return { current: updated, changed: true };
    }, { isolationLevel: 'ReadCommitted' });

    const order = await prisma.sellerOrder.findUnique({ where: { id: result.current.id }, include: { shipmentUpdates: { orderBy: { createdAt: 'desc' }, take: 20 } } });
    res.json({ sellerOrder: order, alreadyApplied: !result.changed });
  }));

  app.post('/api/orders/:parentOrderId/shipments/:sellerOrderId/confirm-received', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const parentOrderId = param(req.params.parentOrderId);
    const sellerOrderId = param(req.params.sellerOrderId);
    const initial = await prisma.sellerOrder.findFirst({ where: { id: sellerOrderId, parentId: parentOrderId }, select: { id: true, parentId: true } });
    if (!initial) throw fail(404, 'Shipment not found.');

    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ParentOrder" WHERE "id" = ${initial.parentId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SellerOrder" WHERE "id" = ${initial.id} FOR UPDATE`;
      const current = await tx.sellerOrder.findUnique({ where: { id: initial.id }, include: { parent: { include: { payment: true } }, seller: true } });
      if (!current || current.parent.buyerId !== user.id) throw fail(404, 'Shipment not found.');
      if (current.receivedAt) return { receivedAt: current.receivedAt, alreadyConfirmed: true };
      if (!current.shippedAt || !current.shipmentStatus) throw fail(409, 'You can confirm receipt after the seller ships the item.');
      if (current.status === OrderStatus.CANCELLED || current.parent.status === OrderStatus.CANCELLED) throw fail(409, 'Cancelled orders cannot be confirmed as received.');
      const payment = current.parent.payment;
      if (!payment || payment.method === PaymentMethod.POS || (payment.method !== PaymentMethod.COD && payment.status !== PaymentStatus.PAID)) throw fail(409, 'This order is not eligible for receipt confirmation.');
      if (payment.status !== PaymentStatus.PAID && !(payment.method === PaymentMethod.COD && payment.status === PaymentStatus.PENDING)) throw fail(409, 'This payment is not eligible for receipt confirmation.');
      const openCases = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "OrderResolutionCase" WHERE "sellerOrderId" = ${current.id} AND "status" IN ('OPEN', 'UNDER_REVIEW', 'REFUND_APPROVED') LIMIT 1`;
      if (openCases.length) throw fail(409, 'Resolve the open buyer order case before confirming receipt.', 'ORDER_CASE_OPEN');

      const receivedAt = new Date();
      await tx.sellerOrder.update({ where: { id: current.id }, data: { receivedAt, receiptConfirmedById: user.id } });
      await awardClubCoinsForCompletedOrder(tx, current.parentId, receivedAt);
      await tx.auditLog.create({ data: { actorId: user.id, action: 'BUYER_RECEIPT_CONFIRMED', entity: 'SellerOrder', entityId: current.id, metadata: { parentOrderId: current.parentId, shipmentStatus: current.shipmentStatus, paymentMethod: payment.method } } });
      if (current.seller) await createUserNotification(tx, {
        userId: current.seller.userId, eventType: 'BUYER_RECEIPT_CONFIRMED', title: 'Buyer confirmed receipt',
        body: 'The buyer confirmed that the item was received in good condition. Eligible online proceeds remain subject to the configured payout hold.',
        link: '/dashboard?mode=seller&tab=orders', payloadJson: { parentOrderId: current.parentId, sellerOrderId: current.id }
      }, 'orders');
      return { receivedAt, alreadyConfirmed: false };
    }, { isolationLevel: 'ReadCommitted' });
    res.json(result);
  }));
}
