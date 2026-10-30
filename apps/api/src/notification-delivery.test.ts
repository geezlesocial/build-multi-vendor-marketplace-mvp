import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createRoleNotifications, createUserNotification } from './notification-delivery.js';

function mockTransaction(recipient: Record<string, unknown> | null, preference: { enabled: boolean } | null) {
  const notificationCreateMany = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({ count: 1 }));
  const emailCreateMany = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({ count: 1 }));
  const tx = {
    notification: { createMany: notificationCreateMany },
    user: { findMany: vi.fn(async () => recipient ? [recipient] : []) },
    notificationPreference: { findMany: vi.fn(async () => preference ? [{ userId: 'user_1', category: 'orders', enabled: preference.enabled }] : []) },
    emailOutbox: { createMany: emailCreateMany }
  } as unknown as Prisma.TransactionClient;
  return { tx, notificationCreateMany, emailCreateMany };
}

describe('transactional notification enqueue', () => {
  const draft = { userId: 'user_1', eventType: 'ORDER_SHIPMENT_UPDATED', title: 'Shipping progress updated', body: 'Your order shipped.', link: '/dashboard?tab=orders' };

  it('queues email in the same transaction for an active, verified user by default', async () => {
    const { tx, notificationCreateMany, emailCreateMany } = mockTransaction({ id: 'user_1', email: 'buyer@example.test', name: 'Buyer', emailVerifiedAt: new Date(), accountStatus: 'ACTIVE' }, null);
    await createUserNotification(tx, draft, 'orders');
    expect(notificationCreateMany).toHaveBeenCalledOnce();
    const notificationId = notificationCreateMany.mock.calls[0]?.[0].data[0]?.id;
    expect(emailCreateMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ recipientEmail: 'buyer@example.test', recipientUserId: 'user_1', templateKey: 'MARKETPLACE_NOTIFICATION_V1', idempotencyKey: `notification:${notificationId}` })] });
  });

  it('keeps the in-app notification but does not queue disabled or unverified recipients', async () => {
    const optedOut = mockTransaction({ id: 'user_1', email: 'buyer@example.test', name: 'Buyer', emailVerifiedAt: new Date(), accountStatus: 'ACTIVE' }, { enabled: false });
    await createUserNotification(optedOut.tx, draft, 'orders');
    expect(optedOut.notificationCreateMany).toHaveBeenCalledOnce();
    expect(optedOut.emailCreateMany).not.toHaveBeenCalled();

    const unverified = mockTransaction({ id: 'user_1', email: 'buyer@example.test', name: 'Buyer', emailVerifiedAt: null, accountStatus: 'ACTIVE' }, null);
    await createUserNotification(unverified.tx, draft, 'orders');
    expect(unverified.emailCreateMany).not.toHaveBeenCalled();
  });

  it('fans platform alerts out to active admins in the same transaction', async () => {
    const notificationCreateMany = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({ count: 2 }));
    const emailCreateMany = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({ count: 0 }));
    const userFindMany = vi.fn(async (args: { where?: { role?: string; id?: { in?: string[]; notIn?: string[] } } }) => {
      if (args.where?.role === 'ADMIN') return [{ id: 'admin_1' }, { id: 'admin_2' }].filter(user => !args.where?.id?.notIn?.includes(user.id));
      const ids = args.where?.id?.in ?? [];
      return ids.map(id => ({ id, email: `${id}@example.test`, name: id, emailVerifiedAt: null, accountStatus: 'ACTIVE' }));
    });
    const tx = {
      notification: { createMany: notificationCreateMany },
      user: { findMany: userFindMany },
      notificationPreference: { findMany: vi.fn(async () => []) },
      emailOutbox: { createMany: emailCreateMany }
    } as unknown as Prisma.TransactionClient;
    await createRoleNotifications(tx, 'ADMIN', { eventType: 'ACCOUNT_CREATED', title: 'New member', body: 'A member joined.' }, 'account', ['admin_2']);
    expect(notificationCreateMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ userId: 'admin_1', eventType: 'ACCOUNT_CREATED' })] });
    expect(emailCreateMany).not.toHaveBeenCalled();
  });
});
