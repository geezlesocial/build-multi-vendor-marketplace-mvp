import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createUnsubscribeToken, normalizeSubscriberEmail, verifyUnsubscribeToken } from './store-email-domain.js';

describe('Store email consent helpers', () => {
  it('normalizes the email identity used for store-scoped subscriptions', () => {
    expect(normalizeSubscriberEmail('  Buyer.Local@Example.Test ')).toBe('buyer.local@example.test');
  });

  it('signs unsubscribe capabilities and rejects changed or forged tokens', () => {
    const token = createUnsubscribeToken('subscriber_123', 'a dedicated test signing secret with enough entropy');
    expect(verifyUnsubscribeToken(token, 'a dedicated test signing secret with enough entropy')).toBe('subscriber_123');
    expect(verifyUnsubscribeToken(`${token}x`, 'a dedicated test signing secret with enough entropy')).toBeNull();
    expect(verifyUnsubscribeToken(token, 'a different secret')).toBeNull();
    expect(verifyUnsubscribeToken('not-a-token', 'a dedicated test signing secret with enough entropy')).toBeNull();
  });

  it('does not place the address in token material', () => {
    const token = createUnsubscribeToken('subscriber_123', 'a dedicated test signing secret with enough entropy');
    expect(token).not.toContain('buyer.local@example.test');
    expect(createHash('sha256').update(token).digest('hex')).toHaveLength(64);
  });
});
