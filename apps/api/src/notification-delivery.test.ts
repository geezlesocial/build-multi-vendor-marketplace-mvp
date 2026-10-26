import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createUserNotification } from './notification-delivery.js';

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
});
