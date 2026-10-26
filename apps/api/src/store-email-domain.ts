import { createHmac, timingSafeEqual } from 'node:crypto';

export function normalizeSubscriberEmail(email: string) {
  return email.trim().toLowerCase();
}

export function createUnsubscribeToken(subscriberId: string, secret: string) {
  const signature = createHmac('sha256', secret).update(subscriberId).digest('base64url');
  return `${subscriberId}.${signature}`;
}

export function verifyUnsubscribeToken(token: string, secret: string) {
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  const subscriberId = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(subscriberId).digest('base64url'));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return subscriberId;
}
