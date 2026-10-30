import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { notifyOrderParties } from './order-notifications.js';

describe('order lifecycle notifications', () => {
  it('alerts the buyer, order sellers, and other active admins without duplicate recipients', async () => {
    const notificationCreateMany = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({ count: 1 }));
    const userFindMany = vi.fn(async (args: { where?: { role?: string; id?: { in?: string[]; notIn?: string[] } } }) => {
      if (args.where?.role === 'ADMIN') return [{ id: 'admin_1' }, { id: 'seller_user' }].filter(user => !args.where?.id?.notIn?.includes(user.id));
      return (args.where?.id?.in ?? []).map(id => ({ id, email: `${id}@example.test`, name: id, emailVerifiedAt: null, accountStatus: 'ACTIVE' }));
    });
    const tx = {
      seller: { findMany: vi.fn(async () => [{ userId: 'seller_user' }]) },
      notification: { createMany: notificationCreateMany },
      user: { findMany: userFindMany },
      notificationPreference: { findMany: vi.fn(async () => []) },
      emailOutbox: { createMany: vi.fn(async () => ({ count: 0 })) }
    } as unknown as Prisma.TransactionClient;

    await notifyOrderParties(tx, {
      orderId: 'order_1', orderNumber: 'MV-1', buyerId: 'buyer_user', sellerIds: ['seller_1', null], eventType: 'ORDER_CREATED',
      buyer: { title: 'Order recorded', body: 'Your order was recorded.', link: '/dashboard?tab=orders' },
      seller: { title: 'New order', body: 'Your Store received an order.', link: '/dashboard?mode=seller&tab=orders' },
      admin: { title: 'Order placed', body: 'A marketplace order was placed.', link: '/admin/platform?section=orders' }
    });

    expect(notificationCreateMany).toHaveBeenCalledTimes(2);
    expect(notificationCreateMany.mock.calls[0]?.[0].data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'buyer_user', eventType: 'ORDER_CREATED' }),
      expect.objectContaining({ userId: 'seller_user', eventType: 'ORDER_CREATED' })
    ]));
    expect(notificationCreateMany.mock.calls[1]?.[0].data).toEqual([expect.objectContaining({ userId: 'admin_1', eventType: 'ORDER_CREATED' })]);
  });
});
