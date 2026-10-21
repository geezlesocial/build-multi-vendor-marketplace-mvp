import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TARGET_TEST_DATABASE_URL;
if (!databaseUrl && /^(1|true)$/i.test(process.env.CI ?? '')) {
  throw new Error('WALLET_FUNDING_TARGET_TEST_DATABASE_URL is required in CI; refusing to skip wallet funding target safety verification');
}
if (databaseUrl) validateE2EDatabaseURL(databaseUrl);

test('wallet funding routes reject non-disposable runtime database targets before writes', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.WALLET_FUNDING_SANDBOX_MODE = 'true';
  process.env.WALLET_FUNDING_PROVIDER_READY = 'true';
  process.env.MONEY_MOVEMENT_HARD_DISABLED = 'false';
  process.env.CLUB_COINS_HARD_DISABLED = 'true';
  process.env.WALLET_FUNDING_TREASURY_ACCOUNT_ID = 'wallet-funding-target-safety-test-treasury';

  const [{ app }, security, config, funding] = await Promise.all([
    import('../apps/api/src/index.ts'),
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/config.ts'),
    import('../apps/api/src/wallet-funding.ts')
  ]);
  const { prisma, tokenHash } = security;
  const { env } = config;
  const { walletFundingSandboxEnabled } = funding;
  const user = await prisma.user.create({ data: { email: `wallet-funding-target-safety-${Date.now()}@example.test`, name: 'Wallet Funding Target Safety', role: 'BUYER', passwordHash: 'synthetic-only' } });
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await prisma.session.create({ data: { tokenHash: tokenHash(sessionToken), userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });

  const fundingStateCounts = async () => Promise.all([
    prisma.walletFundingIntent.count(),
    prisma.walletBalance.count(),
    prisma.walletLedgerTransaction.count(),
    prisma.walletBalanceAllocation.count(),
    prisma.processedWebhookEvent.count()
  ]);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: `${env.SESSION_COOKIE_NAME}=${sessionToken}; marketplace_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
      ...(options.headers ?? {})
    }
  });
  const fundingPayload = { amountMinor: 25, currency: 'USD', provider: 'STRIPE', idempotencyKey: 'target-safety-funding-1' };
  const originalDatabaseUrl = env.DATABASE_URL;

  try {
    for (const target of [
      'postgresql://synthetic:synthetic@db.example.test:5432/wallet_funding_test',
      'postgresql://synthetic:synthetic@127.0.0.1:5432/marketplace'
    ]) {
      assert.equal(walletFundingSandboxEnabled(target), false);
      env.DATABASE_URL = target;
      const before = await fundingStateCounts();
      const fundingResponse = await request('/api/wallet/funding-intents', { method: 'POST', body: JSON.stringify(fundingPayload) });
      assert.equal(fundingResponse.status, 409);
      assert.deepEqual(await fundingStateCounts(), before);
    }

    env.DATABASE_URL = originalDatabaseUrl;
    assert.equal(walletFundingSandboxEnabled(databaseUrl), true);
    const beforeWebhook = await fundingStateCounts();
    env.DATABASE_URL = 'postgresql://synthetic:synthetic@db.example.test:5432/wallet_funding_test';
    const webhookResponse = await request('/api/webhooks/stripe/wallet-funding', { method: 'POST', body: '{}' });
    assert.equal(webhookResponse.status, 503);
    assert.deepEqual(await fundingStateCounts(), beforeWebhook);
  } finally {
    env.DATABASE_URL = originalDatabaseUrl;
    await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  }
});
