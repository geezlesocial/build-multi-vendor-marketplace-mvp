import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

type DatabaseTransaction = Prisma.TransactionClient;

export type NotificationDraft = {
  userId: string;
  eventType: string;
  title: string;
  body: string;
  link?: string | null;
  payloadJson?: Prisma.InputJsonValue;
};

export type NotificationCategory = 'orders' | 'support' | 'account';

/** Persist the in-app event and, when enabled, its transactional email in the same DB transaction. */
export async function createUserNotification(tx: DatabaseTransaction, draft: NotificationDraft, category: NotificationCategory) {
  await createUserNotifications(tx, [{ draft, category }]);
}

export async function createUserNotifications(tx: DatabaseTransaction, drafts: Array<{ draft: NotificationDraft; category: NotificationCategory }>) {
  if (!drafts.length) return;
  const rows = drafts.map(item => ({ id: randomUUID(), ...item }));
  await tx.notification.createMany({ data: rows.map(({ id, draft }) => ({ id, ...draft })) });
  const userIds = [...new Set(rows.map(row => row.draft.userId))];
  const categories = [...new Set(rows.map(row => row.category))];
  const [recipients, preferences] = await Promise.all([
    tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true, emailVerifiedAt: true, accountStatus: true } }),
    tx.notificationPreference.findMany({ where: { userId: { in: userIds }, channel: 'EMAIL', category: { in: categories } }, select: { userId: true, category: true, enabled: true } })
  ]);
  const recipientById = new Map(recipients.map(recipient => [recipient.id, recipient]));
  const preferenceByKey = new Map(preferences.map(preference => [`${preference.userId}:${preference.category}`, preference.enabled]));
  const outboxRows = rows.flatMap(({ id, draft, category }) => {
    const recipient = recipientById.get(draft.userId);
    const enabled = preferenceByKey.get(`${draft.userId}:${category}`);
    if (!recipient || recipient.accountStatus !== 'ACTIVE' || !recipient.emailVerifiedAt || enabled === false) return [];
    return [{
      recipientEmail: recipient.email,
      recipientUserId: recipient.id,
      templateKey: 'MARKETPLACE_NOTIFICATION_V1',
      payloadJson: { category, recipientName: recipient.name, title: draft.title, body: draft.body, link: draft.link ?? null },
      idempotencyKey: `notification:${id}`
    }];
  });
  if (outboxRows.length) await tx.emailOutbox.createMany({ data: outboxRows });
}
