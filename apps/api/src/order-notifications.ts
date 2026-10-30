import type { Prisma } from '@prisma/client';
import { Role } from '@prisma/client';
import { createRoleNotifications, createUserNotifications } from './notification-delivery.js';

type Transaction = Prisma.TransactionClient;

type OrderLifecycleNotice = {
  orderId: string;
  orderNumber: string;
  buyerId: string | null;
  sellerIds: Array<string | null>;
  eventType: string;
  buyer: { title: string; body: string; link: string };
  seller: { title: string; body: string; link: string };
  admin: { title: string; body: string; link: string };
};

/** Writes buyer, affected seller, and administrator alerts with the order transaction. */
export async function notifyOrderParties(tx: Transaction, notice: OrderLifecycleNotice) {
  const sellerIds = [...new Set(notice.sellerIds.filter((id): id is string => Boolean(id)))];
  const sellers = sellerIds.length ? await tx.seller.findMany({ where: { id: { in: sellerIds } }, select: { userId: true } }) : [];
  const directUserIds = [...new Set([notice.buyerId, ...sellers.map(seller => seller.userId)].filter((id): id is string => Boolean(id)))];
  await createUserNotifications(tx, [
    ...(notice.buyerId ? [{ category: 'orders' as const, draft: { userId: notice.buyerId, eventType: notice.eventType, ...notice.buyer, payloadJson: { parentOrderId: notice.orderId, orderNumber: notice.orderNumber } } }] : []),
    ...sellers.map(seller => ({ category: 'orders' as const, draft: { userId: seller.userId, eventType: notice.eventType, ...notice.seller, payloadJson: { parentOrderId: notice.orderId, orderNumber: notice.orderNumber } } }))
  ]);
  await createRoleNotifications(tx, Role.ADMIN, {
    eventType: notice.eventType,
    ...notice.admin,
    payloadJson: { parentOrderId: notice.orderId, orderNumber: notice.orderNumber }
  }, 'orders', directUserIds);
}
