import { z } from 'zod';

function escapeEmailHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export const transactionalNotificationPayloadSchema = z.object({
  category: z.enum(['orders', 'support', 'account']),
  recipientName: z.string().trim().min(1).max(100),
  title: z.string().trim().min(2).max(160).refine(value => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(4000),
  link: z.string().max(1000).nullable().optional()
}).strict();

export type TransactionalNotificationPayload = z.infer<typeof transactionalNotificationPayloadSchema>;

export function renderTransactionalNotification(payload: TransactionalNotificationPayload, webOrigin: string) {
  const base = new URL(webOrigin);
  const link = payload.link && payload.link.startsWith('/') && !payload.link.startsWith('//') && !/[\r\n]/.test(payload.link)
    ? new URL(payload.link, base)
    : null;
  const safeLink = link?.origin === base.origin ? link.toString() : null;
  const name = escapeEmailHtml(payload.recipientName);
  const title = escapeEmailHtml(payload.title);
  const body = escapeEmailHtml(payload.body).replaceAll('\n', '<br>');
  const preferencesUrl = new URL('/settings', base).toString();
  const actionText = safeLink ? `\n\nOpen Market Lane: ${safeLink}` : '';
  return {
    subject: `${payload.title} - Market Lane`,
    text: `Hello ${payload.recipientName},\n\n${payload.body}${actionText}\n\nManage email notification preferences: ${preferencesUrl}\n\nThis is a transactional account notification.`,
    html: `<main><h1>${title}</h1><p>Hello ${name},</p><p>${body}</p>${safeLink ? `<p><a href="${escapeEmailHtml(safeLink)}">Open Market Lane</a></p>` : ''}<p><a href="${escapeEmailHtml(preferencesUrl)}">Manage email notification preferences</a></p><p style="color:#59645e;font-size:12px">This is a transactional account notification.</p></main>`
  };
}

export function transactionalRetryDelayMs(attempt: number) {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}
