import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const smtp = { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() };
  const env = {
    STORE_EMAIL_SMTP_HOST: 'smtp.test.invalid', STORE_EMAIL_SMTP_PORT: 587, STORE_EMAIL_SMTP_SECURE: false,
    STORE_EMAIL_SMTP_REQUIRE_TLS: true, STORE_EMAIL_SMTP_USER: 'test-user', STORE_EMAIL_SMTP_PASSWORD: 'not-a-real-secret',
    STORE_EMAIL_FROM: 'noreply@example.test', STORE_EMAIL_REPLY_TO: undefined,
    STORE_EMAIL_TOKEN_SECRET: undefined, STORE_EMAIL_DELIVERY_AVAILABLE: false,
    WEB_ORIGIN: 'https://market.example', SITE_URL: 'https://api.market.example'
  };
  return { smtp, env, createTransport: vi.fn(() => smtp) };
});

vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock('./config.js', () => ({ env: mocks.env }));
vi.mock('./store-email-provider-config.js', () => ({
  resolvePlatformEmailSettings: async () => ({ provider: 'DEPLOYMENT_ENVIRONMENT', providerLabel: 'Deployment environment', host: mocks.env.STORE_EMAIL_SMTP_HOST, port: mocks.env.STORE_EMAIL_SMTP_PORT, secure: mocks.env.STORE_EMAIL_SMTP_SECURE, requireTls: mocks.env.STORE_EMAIL_SMTP_REQUIRE_TLS, username: mocks.env.STORE_EMAIL_SMTP_USER, password: mocks.env.STORE_EMAIL_SMTP_PASSWORD, senderName: 'Market Lane', senderEmail: mocks.env.STORE_EMAIL_FROM, source: 'DEPLOYMENT_ENVIRONMENT' }),
  emailSettingsVerified: (_settings: unknown, environmentVerified: boolean) => environmentVerified,
  verifyActiveEmailProvider: vi.fn()
}));

import { accountVerificationEmailStatus, closeStoreEmailTransport, sendTransactionalNotificationEmail, storeEmailProviderStatus, verifyStoreEmailSmtp } from './store-email-delivery.js';

describe('platform SMTP transport', () => {
  beforeEach(() => {
    closeStoreEmailTransport();
    vi.clearAllMocks();
    mocks.smtp.verify.mockResolvedValue(true);
    mocks.smtp.sendMail.mockResolvedValue({ messageId: '<accepted@example.test>' });
  });

  it('verifies SMTP without sending and delivers transactional mail without marketing consent or gate', async () => {
    expect((await storeEmailProviderStatus()).enabled).toBe(false);
    expect((await accountVerificationEmailStatus()).available).toBe(false);
    await expect(verifyStoreEmailSmtp()).resolves.toEqual({ verified: true });
    expect(mocks.smtp.verify).toHaveBeenCalledOnce();
    expect(mocks.smtp.sendMail).not.toHaveBeenCalled();
    expect((await accountVerificationEmailStatus()).available).toBe(true);
    expect((await storeEmailProviderStatus()).enabled).toBe(false);

    await expect(sendTransactionalNotificationEmail({ to: 'buyer@example.test', subject: 'Order update', text: 'Shipped', html: '<p>Shipped</p>', messageId: '<outbox@example.test>' })).resolves.toEqual({ messageId: '<accepted@example.test>' });
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.test.invalid', port: 587, requireTLS: true, auth: { user: 'test-user', pass: 'not-a-real-secret' }, disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1 }));
    expect(mocks.smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.test', subject: 'Order update', messageId: '<outbox@example.test>', from: { name: 'Market Lane', address: 'noreply@example.test' } }));
  });

  it('maps provider authentication failures to a safe error and leaves SMTP unverified', async () => {
    mocks.smtp.verify.mockRejectedValueOnce(Object.assign(new Error('credential details must not escape'), { code: 'EAUTH' }));
    await expect(verifyStoreEmailSmtp()).rejects.toMatchObject({ code: 'EMAIL_AUTH_FAILED', message: 'The configured email provider rejected its credentials.' });
    expect((await accountVerificationEmailStatus()).available).toBe(false);
  });
});
