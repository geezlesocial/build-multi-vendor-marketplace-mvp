import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('WALLET_FUNDING_TEST_DATABASE_URL is required for the guarded seller dashboard regression.');
const { databaseName } = validateE2EDatabaseURL(databaseUrl);
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID ?? '';
const identity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(databaseName)?.[1];
if (!identity || identity !== sandboxId) throw new Error('Seller dashboard regression requires a matching wallet_funding_e2e_<id> database identity.');
const isolatedDotenvPath = path.join(os.tmpdir(), `marketplace-no-dotenv-dashboard-${sandboxId}`);
if (existsSync(isolatedDotenvPath)) throw new Error('The isolated dotenv path unexpectedly exists; refusing to load environment files.');
process.env.DOTENV_CONFIG_PATH = isolatedDotenvPath;
process.env.DATABASE_URL = databaseUrl;
process.env.E2E_DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.SESSION_COOKIE_NAME = 'marketplace_session';
process.env.PASSWORD_PEPPER = 'synthetic-dashboard-test-pepper';
process.env.CURRENCY = 'USD';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_dashboard_no_network';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic_dashboard_no_network';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.PAYPAL_WEBHOOK_ID = '';
process.env.MONEY_MOVEMENT_HARD_DISABLED = 'true';
process.env.WALLET_FUNDING_SANDBOX_MODE = 'false';
process.env.WALLET_FUNDING_PROVIDER_READY = 'false';
process.env.CLUB_COINS_HARD_DISABLED = 'true';
process.env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE = 'false';

test('seller dashboard currency aggregates cover historical pages without combining currencies', async () => {
  const [{ prisma, tokenHash }, { app }, safety] = await Promise.all([
    import('../apps/api/src/security.ts'),
    import('../apps/api/src/index.ts'),
    import('../apps/api/src/wallet-safety.ts')
  ]);
  assert.equal(safety.isDisposableWalletFundingDatabaseUrl(databaseUrl, sandboxId), true);
  const suffix = randomUUID().replaceAll('-', '');
  const userId = `dash-user-${suffix}`;
  const sellerId = `dash-seller-${suffix}`;
  const storeId = `dash-store-${suffix}`;
  const orderIds = [];
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const user = await prisma.user.create({ data: {
      id: userId, email: `seller-dashboard-${suffix}@example.test`, name: 'Synthetic Dashboard Seller',
      role: 'SELLER', passwordHash: 'synthetic-only'
    } });
    const seller = await prisma.seller.create({ data: { id: sellerId, userId: user.id, status: 'APPROVED' } });
    await prisma.store.create({ data: { id: storeId, sellerId: seller.id, name: 'Synthetic Dashboard Store', slug: `dash-${suffix}`, baseCurrency: 'USD' } });
    const sessionToken = randomUUID().replaceAll('-', '');
    await prisma.session.create({ data: { userId: user.id, tokenHash: tokenHash(sessionToken), expiresAt: new Date(Date.now() + 60_000) } });

    const rows = [
      ...Array.from({ length: 102 }, (_, index) => ({ currency: 'USD', totalMinor: 10_000, status: 'CONFIRMED', index })),
      ...Array.from({ length: 103 }, (_, index) => ({ currency: 'JPY', totalMinor: 20_000, status: 'CONFIRMED', index: 102 + index })),
      { currency: 'USD', totalMinor: 999_999, status: 'CANCELLED', index: 205 }
    ];
    const parentData = rows.map(row => {
      const id = `dash-parent-${suffix}-${row.index}`;
      orderIds.push(id);
      return {
        id, orderNumber: `DASH-${suffix.slice(0, 12)}-${row.index}`, buyerEmail: 'synthetic@example.test',
        buyerName: 'Synthetic Buyer', addressJson: { country: 'US' }, totalMinor: row.totalMinor,
        currency: row.currency, status: 'CONFIRMED'
      };
    });
    await prisma.parentOrder.createMany({ data: parentData });
    await prisma.sellerOrder.createMany({ data: rows.map(row => ({
      id: `dash-seller-order-${suffix}-${row.index}`, parentId: `dash-parent-${suffix}-${row.index}`,
      sellerId: seller.id, totalMinor: row.totalMinor, status: row.status
    })) });

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = { cookie: `marketplace_session=${sessionToken}` };
    for (const endpoint of ['/api/dashboard/seller', '/api/seller/summary']) {
      const response = await fetch(`${baseUrl}${endpoint}`, { headers });
      const responseBody = await response.text();
      assert.equal(response.status, 200, `${endpoint}: ${responseBody}`);
      const data = JSON.parse(responseBody);
      assert.equal(data.summary?.orderCount ?? data.orderCount, 205);
      const totals = data.summary?.grossByCurrency ?? data.grossByCurrency;
      assert.deepEqual(totals, [
        { currency: 'JPY', grossMinor: 2_060_000 },
        { currency: 'USD', grossMinor: 1_020_000 }
      ]);
      assert.equal('grossMinor' in (data.summary ?? data), false, 'the response must not expose a cross-currency scalar');
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (orderIds.length) {
      await prisma.sellerOrder.deleteMany({ where: { parentId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.seller.deleteMany({ where: { id: sellerId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
