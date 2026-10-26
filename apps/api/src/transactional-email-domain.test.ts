import { describe, expect, it } from 'vitest';
import { renderTransactionalNotification, transactionalNotificationPayloadSchema, transactionalRetryDelayMs } from './transactional-email-domain.js';

describe('transactional email rendering and retry policy', () => {
  it('escapes user-visible content and creates only same-origin action links', () => {
    const payload = transactionalNotificationPayloadSchema.parse({
      category: 'support', recipientName: '<Buyer>', title: 'Ticket update',
      body: 'A <seller> replied & updated your case.', link: '/dashboard?tab=messages'
    });
    const rendered = renderTransactionalNotification(payload, 'https://market.example');
    expect(rendered.subject).toBe('Ticket update - Market Lane');
    expect(rendered.html).toContain('Hello &lt;Buyer&gt;');
    expect(rendered.html).toContain('A &lt;seller&gt; replied &amp; updated your case.');
    expect(rendered.html).toContain('https://market.example/dashboard?tab=messages');
    expect(rendered.html).not.toContain('href="https://attacker.example');
  });

  it('omits external and protocol-relative links instead of embedding them', () => {
    const external = transactionalNotificationPayloadSchema.parse({ category: 'orders', recipientName: 'Buyer', title: 'Delivery update', body: 'Your parcel moved.', link: 'https://attacker.example/phish' });
    const protocolRelative = transactionalNotificationPayloadSchema.parse({ category: 'orders', recipientName: 'Buyer', title: 'Delivery update', body: 'Your parcel moved.', link: '//attacker.example/phish' });
    expect(renderTransactionalNotification(external, 'https://market.example').html).not.toContain('attacker.example');
    expect(renderTransactionalNotification(protocolRelative, 'https://market.example').html).not.toContain('attacker.example');
  });

  it('rejects header injection and bounds exponential retries', () => {
    expect(transactionalNotificationPayloadSchema.safeParse({ category: 'orders', recipientName: 'Buyer', title: 'Hello\r\nBcc: attacker@example.test', body: 'Order update' }).success).toBe(false);
    expect(transactionalRetryDelayMs(1)).toBe(30_000);
    expect(transactionalRetryDelayMs(3)).toBe(120_000);
    expect(transactionalRetryDelayMs(20)).toBe(30 * 60_000);
  });
});
