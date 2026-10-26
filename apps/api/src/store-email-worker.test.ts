import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeTransportError extends Error {
    constructor(readonly code: 'EMAIL_PROVIDER_NOT_CONFIGURED' | 'EMAIL_CONNECTION_FAILED' | 'EMAIL_AUTH_FAILED') { super(code); }
  }
  const outbox = {
    id: 'outbox_1', status: 'SENDING', attempts: 1, templateKey: 'MARKETPLACE_NOTIFICATION_V1',
    recipientEmail: 'buyer@example.test', recipientUserId: 'buyer_1',
    payloadJson: { category: 'orders', recipientName: 'Buyer', title: 'Order update', body: 'Your order shipped.', link: '/dashboard?tab=orders' },
    recipientUser: { id: 'buyer_1', email: 'buyer@example.test', name: 'Buyer', emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'), accountStatus: 'ACTIVE' }
  };
  const queryRaw = vi.fn(async () => [] as Array<{ id: string }>);
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRaw: queryRaw }));
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: transaction,
    emailOutbox: { findUnique: vi.fn(async () => outbox) },
    notificationPreference: { findUnique: vi.fn(async () => ({ enabled: true })) }
  };
  const send = vi.fn(async () => ({ messageId: '<accepted@example.test>' }));
  const providerStatus = vi.fn(() => ({ available: true }));
  const env = { WEB_ORIGIN: 'https://market.example', STORE_EMAIL_SMTP_HOST: 'smtp.test.invalid' };
  return { FakeTransportError, outbox, queryRaw, transaction, executeRaw, prisma, send, providerStatus, env };
});

vi.mock('./security.js', () => ({ prisma: mocks.prisma }));
vi.mock('./config.js', () => ({ env: mocks.env }));
vi.mock('./store-email-delivery.js', () => ({
  accountVerificationEmailStatus: mocks.providerStatus,
  sendStoreEmailCampaign: vi.fn(),
  sendTransactionalNotificationEmail: mocks.send,
  transactionalEmailMessageId: vi.fn(async (outboxId: string) => `<${outboxId}@smtp.test.invalid>`),
  StoreEmailTransportError: mocks.FakeTransportError,
  storeEmailProviderStatus: vi.fn(() => ({ enabled: false }))
}));

import { processTransactionalEmailOutboxBatch } from './store-email-worker.js';

function rawSql(call: unknown[]) {
  const parts = call[0] as TemplateStringsArray;
  return parts.reduce((sql, part, index) => `${sql}${part}${index + 1 < call.length ? String(call[index + 1]) : ''}`, '');
}

describe('transactional email outbox worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.outbox.status = 'SENDING';
    mocks.outbox.attempts = 1;
    mocks.outbox.recipientUser.emailVerifiedAt = new Date('2026-10-01T00:00:00.000Z');
    mocks.outbox.recipientUser.accountStatus = 'ACTIVE';
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([{ id: 'outbox_1' }]);
    mocks.prisma.notificationPreference.findUnique.mockResolvedValue({ enabled: true });
    mocks.providerStatus.mockReturnValue({ available: true });
    mocks.send.mockResolvedValue({ messageId: '<accepted@example.test>' });
  });

  it('claims and sends an eligible notification, then records SMTP acceptance', async () => {
    await expect(processTransactionalEmailOutboxBatch(new Date('2026-10-26T00:00:00.000Z'))).resolves.toBe(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.test', subject: 'Order update - Market Lane', messageId: '<outbox_1@smtp.test.invalid>' }));
    expect(mocks.executeRaw.mock.calls.some(call => rawSql(call).includes("'SENT'"))).toBe(true);
  });

  it('suppresses an email when the user disables that category before send', async () => {
    mocks.prisma.notificationPreference.findUnique.mockResolvedValue({ enabled: false });
    await expect(processTransactionalEmailOutboxBatch()).resolves.toBe(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.executeRaw.mock.calls.some(call => rawSql(call).includes("'SUPPRESSED'"))).toBe(true);
  });

  it('requeues transient SMTP failures with a safe code and bounded backoff', async () => {
    mocks.send.mockRejectedValueOnce(new mocks.FakeTransportError('EMAIL_CONNECTION_FAILED'));
    const now = new Date('2026-10-26T00:00:00.000Z');
    await expect(processTransactionalEmailOutboxBatch(now)).resolves.toBe(1);
    const retryUpdate = (mocks.executeRaw.mock.calls as unknown as unknown[][]).find(call => call.includes('EMAIL_CONNECTION_FAILED'));
    expect(retryUpdate).toBeDefined();
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
