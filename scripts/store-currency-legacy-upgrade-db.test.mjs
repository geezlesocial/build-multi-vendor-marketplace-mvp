import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTestPrismaClient } from './prisma-test-client.mjs';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';
import { isDisposableWalletFundingDatabaseUrl } from '../apps/api/src/wallet-safety.ts';

const currentUrl = process.env.WALLET_FUNDING_TEST_DATABASE_URL;
const mixedUrl = process.env.WALLET_FUNDING_MIXED_TEST_DATABASE_URL;
const unsupportedUrl = process.env.WALLET_FUNDING_UNSUPPORTED_TEST_DATABASE_URL;
if (!currentUrl || !mixedUrl || !unsupportedUrl) throw new Error('Three fresh guarded disposable PostgreSQL databases are required for the legacy currency upgrade regression.');
const currentTarget = validateE2EDatabaseURL(currentUrl);
const mixedTarget = validateE2EDatabaseURL(mixedUrl);
const unsupportedTarget = validateE2EDatabaseURL(unsupportedUrl);
const currentIdentity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(currentTarget.databaseName)?.[1];
const mixedIdentity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(mixedTarget.databaseName)?.[1];
const unsupportedIdentity = /^wallet_funding_e2e_([a-f0-9]{32})$/.exec(unsupportedTarget.databaseName)?.[1];
if (!currentIdentity || currentIdentity !== process.env.WALLET_FUNDING_SANDBOX_ID
  || !mixedIdentity || mixedIdentity !== process.env.WALLET_FUNDING_MIXED_SANDBOX_ID
  || !unsupportedIdentity || unsupportedIdentity !== process.env.WALLET_FUNDING_UNSUPPORTED_SANDBOX_ID
  || new Set([currentIdentity, mixedIdentity, unsupportedIdentity]).size !== 3) {
  throw new Error('Each migration regression database must use its own matching wallet_funding_e2e_<id> identity.');
}
if (!isDisposableWalletFundingDatabaseUrl(currentUrl, currentIdentity)
  || !isDisposableWalletFundingDatabaseUrl(mixedUrl, mixedIdentity)
  || !isDisposableWalletFundingDatabaseUrl(unsupportedUrl, unsupportedIdentity)) {
  throw new Error('Each migration regression target must pass the API wallet-funding disposable-database guard.');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const isolatedTempRoot = os.tmpdir();
if (existsSync(path.join(isolatedTempRoot, '.env'))) {
  throw new Error('The migration regression temporary working directory must not contain a .env file.');
}
const prismaDir = path.join(rootDir, 'apps', 'api', 'prisma');
const prismaCli = [
  path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js'),
  path.join(rootDir, 'apps', 'api', 'node_modules', 'prisma', 'build', 'index.js')
].find(candidate => existsSync(candidate));
if (!prismaCli) throw new Error('Local Prisma CLI was not found; refusing to download dependencies.');

function migrationDirectories() {
  return readdirSync(path.join(prismaDir, 'migrations'))
    .filter(name => statSync(path.join(prismaDir, 'migrations', name)).isDirectory() && existsSync(path.join(prismaDir, 'migrations', name, 'migration.sql')))
    .sort();
}

function addMigrations(tempDir, names) {
  const migrationsDir = path.join(tempDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync(path.join(prismaDir, 'migrations', 'migration_lock.toml'), path.join(migrationsDir, 'migration_lock.toml'));
  for (const name of names) cpSync(path.join(prismaDir, 'migrations', name), path.join(migrationsDir, name), { recursive: true });
}

function deploy(tempDir, databaseUrl) {
  const result = spawnSync(process.execPath, [
    prismaCli, 'migrate', 'deploy', '--config', path.join(rootDir, 'apps', 'api', 'prisma.config.ts'), '--schema', path.join(tempDir, 'schema.prisma')
  ], {
    // Keep Prisma's process working directory outside the per-schema workspace.
    // On Windows, a process cwd can prevent that workspace from being removed.
    cwd: isolatedTempRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PRISMA_MIGRATIONS_PATH: path.join(tempDir, 'migrations'),
      DOTENV_CONFIG_PATH: path.join(tempDir, 'no-env-file')
    },
    encoding: 'utf8',
    windowsHide: true
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(databaseUrl, '[redacted disposable database URL]');
  return { status: result.status, error: result.error, output };
}

function expectDeploySuccess(tempDir, databaseUrl) {
  const result = deploy(tempDir, databaseUrl);
  assert.equal(result.error, undefined, `Prisma migrate deploy could not start: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, `Prisma migrate deploy failed (${result.status}):\n${result.output}`);
  return result.output;
}

function createTempProject(identity) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `marketplace-store-currency-upgrade-${identity}-`));
  assert.equal(existsSync(path.join(tempDir, '.env')), false);
  cpSync(path.join(prismaDir, 'schema.prisma'), path.join(tempDir, 'schema.prisma'));
  return tempDir;
}

async function insertLegacySellerAndStore(db, id, currencyCodes) {
  const userId = `${id}-user`;
  const sellerId = `${id}-seller`;
  const storeId = `${id}-store`;
  const storeSlug = `historical-${id}`;
  await db.$executeRaw`INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "createdAt", "updatedAt")
    VALUES (${userId}, ${`${id}@example.test`}, 'synthetic-only', 'Historical seller', 'SELLER'::"Role", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  await db.$executeRaw`INSERT INTO "Seller" ("id", "userId", "status", "createdAt", "updatedAt")
    VALUES (${sellerId}, ${userId}, 'APPROVED'::"SellerStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  await db.$executeRaw`INSERT INTO "Store" ("id", "sellerId", "name", "slug")
    VALUES (${storeId}, ${sellerId}, ${`Historical ${id}`}, ${storeSlug})`;

  const products = [];
  for (let index = 0; index < currencyCodes.length; index += 1) {
    const code = currencyCodes[index];
    const productId = `${id}-product-${index}`;
    await db.$executeRaw`INSERT INTO "Product" ("id", "sellerId", "name", "slug", "description", "priceMinor", "currency", "status", "createdAt", "updatedAt")
      VALUES (${productId}, ${sellerId}, ${`Historical product ${index}`}, ${`historical-product-${id}-${index}`}, 'Pre-currency-catalog fixture', ${12_345 + index}, ${code}, 'APPROVED'::"ProductStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    products.push({ id: productId, currency: code, priceMinor: 12_345 + index });
  }

  return { userId, sellerId, storeId, slug: storeSlug, products };
}

async function insertLegacyVariant(db, id, product, currency) {
  await db.$executeRaw`INSERT INTO "ProductVariant" ("id", "productId", "name", "sku", "priceMinor", "currency", "stock", "status", "createdAt", "updatedAt")
    VALUES (${`${id}-variant`}, ${product.id}, 'Historical size', ${`${id}-sku`}, 4_321, ${currency}, 7, 'APPROVED'::"ProductStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
}

async function insertHistoricalOrder(db, fixture, suffix) {
  const product = fixture.products[0];
  const orderId = `${suffix}-order`;
  const sellerOrderId = `${suffix}-seller-order`;
  const paymentId = `${suffix}-payment`;
  const itemId = `${suffix}-item`;
  const orderTotal = product.priceMinor * 2;
  await db.$executeRaw`INSERT INTO "ParentOrder" ("id", "orderNumber", "buyerEmail", "buyerName", "addressJson", "totalMinor", "currency", "status", "createdAt")
    VALUES (${orderId}, ${`LEGACY-${suffix}`}, 'legacy-buyer@example.test', 'Legacy Buyer', '{}'::jsonb, ${orderTotal}, ${product.currency}, 'PENDING'::"OrderStatus", CURRENT_TIMESTAMP)`;
  await db.$executeRaw`INSERT INTO "SellerOrder" ("id", "parentId", "sellerId", "status", "totalMinor")
    VALUES (${sellerOrderId}, ${orderId}, ${fixture.sellerId}, 'PENDING'::"OrderStatus", ${orderTotal})`;
  await db.$executeRaw`INSERT INTO "Payment" ("id", "parentId", "method", "status")
    VALUES (${paymentId}, ${orderId}, 'STRIPE'::"PaymentMethod", 'PENDING'::"PaymentStatus")`;
  await db.$executeRaw`INSERT INTO "OrderItem" ("id", "sellerOrderId", "productId", "productName", "unitPriceMinor", "quantity")
    VALUES (${itemId}, ${sellerOrderId}, ${product.id}, 'Historical product', ${product.priceMinor}, 2)`;
  return { orderId, paymentId, itemId, orderTotal, currency: product.currency, unitPriceMinor: product.priceMinor };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function availableLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startTestApi(databaseUrl, sandboxId, tempDir) {
  const port = await availableLoopbackPort();
  const api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: rootDir,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      WINDIR: process.env.WINDIR ?? '',
      TEMP: isolatedTempRoot,
      TMP: isolatedTempRoot,
      NODE_ENV: 'development',
      DOTENV_CONFIG_PATH: path.join(tempDir, 'no-env-file'),
      DATABASE_URL: databaseUrl,
      E2E_DATABASE_URL: databaseUrl,
      API_PORT: String(port),
      WEB_ORIGIN: `http://127.0.0.1:${port}`,
      SITE_URL: `http://127.0.0.1:${port}`,
      SESSION_COOKIE_NAME: 'marketplace_session',
      PASSWORD_PEPPER: 'legacy-currency-test-pepper-only',
      CURRENCY: 'USD',
      FX_REFERENCE_FETCH_ENABLED: 'false',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      PAYPAL_WEBHOOK_ID: '',
      PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com',
      LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: 'false',
      LIVE_SHOPPING_AVAILABLE: 'false',
      CONTENT_STORAGE_DIR: path.join(tempDir, 'content'),
      CONTENT_OBJECT_STORAGE_AVAILABLE: 'false',
      CONTENT_SCAN_REQUIRED: 'true',
      CONTENT_SCANNER_AVAILABLE: 'false',
      STORE_BUSTER_SPONSORED_AVAILABLE: 'false',
      STORE_EMAIL_DELIVERY_AVAILABLE: 'false',
      MONEY_MOVEMENT_HARD_DISABLED: 'true',
      WALLET_FUNDING_SANDBOX_MODE: 'false',
      WALLET_FUNDING_PROVIDER_READY: 'false',
      WALLET_FUNDING_SANDBOX_ID: sandboxId,
      WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST: '',
      CLUB_COINS_HARD_DISABLED: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let startupOutput = '';
  const collect = chunk => { startupOutput = `${startupOutput}${chunk}`.slice(-12_000); };
  api.stdout.on('data', collect);
  api.stderr.on('data', collect);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      if (api.exitCode !== null) throw new Error(`Isolated API exited before becoming healthy: ${startupOutput.replaceAll(databaseUrl, '[redacted disposable database URL]')}`);
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return { api, baseUrl };
      } catch { /* Keep polling readiness; no test request is sent until healthy. */ }
      await delay(100);
    }
    throw new Error(`Isolated API did not become healthy: ${startupOutput.replaceAll(databaseUrl, '[redacted disposable database URL]')}`);
  } catch (error) {
    api.kill();
    throw error;
  }
}

async function stopTestApi(api) {
  if (api.exitCode !== null) return;
  const exited = new Promise(resolve => api.once('exit', resolve));
  api.kill();
  await Promise.race([exited, delay(5_000)]);
}

async function verifyPublicCheckoutCompatibility(db, store, product, databaseUrl, sandboxId, tempDir) {
  const buyer = await db.user.create({ data: {
    email: `currency-upgrade-buyer-${sandboxId}@example.test`, name: 'Currency Upgrade Buyer',
    role: 'BUYER', passwordHash: 'synthetic-only-not-a-login-credential'
  } });
  await db.inventory.create({ data: { productId: product.id, quantity: 3 } });
  await db.paymentMethodSettings.upsert({ where: { method: 'COD' }, update: { enabled: true }, create: { id: 'cod', method: 'COD', enabled: true } });
  await db.marketplaceSettings.upsert({ where: { id: 'default' }, update: { multiVendorEnabled: true }, create: { id: 'default', multiVendorEnabled: true } });
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await db.session.create({ data: {
    tokenHash: createHash('sha256').update(sessionToken).digest('hex'), userId: buyer.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  } });
  const cart = await db.cart.create({ data: { userId: buyer.id } });
  await db.cartItem.create({ data: { cartId: cart.id, productId: product.id, quantity: 1 } });
  const orderCountBefore = await db.parentOrder.count({ where: { buyerId: buyer.id } });
  const { api, baseUrl } = await startTestApi(databaseUrl, sandboxId, tempDir);
  const cookie = `marketplace_session=${sessionToken}; marketplace_csrf=${csrfToken}`;
  try {
    const currencyResponse = await fetch(`${baseUrl}/api/stores/${encodeURIComponent(store.slug)}/currencies`);
    assert.equal(currencyResponse.status, 200, 'Public Store currency listing must be available.');
    const currencies = await currencyResponse.json();
    const usd = currencies.currencies.find(entry => entry.code === 'USD');
    assert.ok(usd, 'The explicit compatible-charge-currency offer must be returned for visibility.');
    assert.equal(usd.checkoutAvailable, false, 'A non-USD Store must never advertise USD checkout, even if an explicit legacy offer says checkoutEnabled.');
    assert.equal(currencies.baseCurrency, 'PHP');

    const checkoutResponse = await fetch(`${baseUrl}/api/orders/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        buyerEmail: buyer.email, buyerName: buyer.name, method: 'COD',
        address: { line1: '1 Test Street', city: 'Test City', region: 'TS', postalCode: '1000', country: 'US' }
      })
    });
    const checkoutBody = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 409, JSON.stringify(checkoutBody));
    assert.equal(checkoutBody.code, 'STORE_CHECKOUT_CURRENCY_UNAVAILABLE', 'Checkout must enforce Store/base-currency compatibility before order creation.');
    assert.equal(await db.parentOrder.count({ where: { buyerId: buyer.id } }), orderCountBefore, 'Rejected checkout must not create an order.');
    assert.equal(await db.cartItem.count({ where: { cartId: cart.id } }), 1, 'Rejected checkout must preserve the cart.');
  } finally {
    await stopTestApi(api);
  }
}

test('migration 28+ preserves compatible legacy checkout, disables stale USD capability, exposes incompatibility, and fails unsupported backfills safely', async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = currentUrl;
  process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `marketplace-no-dotenv-${currentIdentity}`);
  const { Prisma } = await import('@prisma/client');
  const currentDb = createTestPrismaClient(currentUrl);
  const mixedDb = createTestPrismaClient(mixedUrl);
  const unsupportedDb = createTestPrismaClient(unsupportedUrl);
  const currentTemp = createTempProject(currentIdentity);
  const mixedTemp = createTempProject(mixedIdentity);
  const unsupportedTemp = createTempProject(unsupportedIdentity);
  const names = migrationDirectories();
  const lastLegacy = '20261023000027_seller_managed_shipping';
  const firstCurrency = '20261023000028_currency_catalog_fx';
  const currencyFoundation = '20261023000029_location_seller_commissions';
  const lastPreviousFeature = '20261024000033_legacy_webhook_reconciliation';
  const currencyBackfill = '20261024000034_legacy_store_currency_backfill';
  assert.ok(names.includes(lastLegacy) && names.includes(firstCurrency) && names.includes(currencyFoundation) && names.includes(lastPreviousFeature) && names.includes(currencyBackfill));
  const preCurrency = names.filter(name => name <= lastLegacy);
  assert.equal(names.indexOf(firstCurrency), preCurrency.length, 'Currency migration 28 must immediately follow the migration-27 schema boundary.');
  assert.equal(names.indexOf(currencyFoundation), names.indexOf(firstCurrency) + 1, 'Migration 29 must immediately follow migration 28.');
  assert.equal(names.at(-1), currencyBackfill, 'Migration 34 must be the final migration in the tested chain.');

  try {
    const targets = [
      { db: currentDb, tempDir: currentTemp, url: currentUrl },
      { db: mixedDb, tempDir: mixedTemp, url: mixedUrl },
      { db: unsupportedDb, tempDir: unsupportedTemp, url: unsupportedUrl }
    ];
    for (const { db, tempDir, url: databaseUrl } of targets) {
      const emptyCheck = await db.$queryRaw`SELECT to_regclass('public."_prisma_migrations"') IS NULL AS empty`;
      assert.equal(emptyCheck[0]?.empty, true, 'Every database must be a fresh, disposable target.');
      addMigrations(tempDir, preCurrency);
      expectDeploySuccess(tempDir, databaseUrl);
    }

    const currentAppliedLegacy = await currentDb.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`;
    assert.equal(currentAppliedLegacy[0]?.count, preCurrency.length, `The fixtures must be inserted after the complete ${lastLegacy} migration boundary, including the initial migration record.`);
    const boundaryMigration = await currentDb.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "migration_name" = ${lastLegacy} AND "finished_at" IS NOT NULL`;
    assert.equal(boundaryMigration[0]?.count, 1, 'The exact preceding schema migration must be applied before historical fixtures are inserted.');
    const usdStore = await insertLegacySellerAndStore(currentDb, `legacy-usd-${currentIdentity}`, ['USD']);
    const phpStore = await insertLegacySellerAndStore(currentDb, `legacy-php-${currentIdentity}`, ['PHP']);
    const phpExplicitOfferStore = await insertLegacySellerAndStore(currentDb, `legacy-php-explicit-${currentIdentity}`, ['PHP']);
    await insertLegacyVariant(currentDb, `legacy-php-${currentIdentity}`, phpStore.products[0], 'PHP');
    const phpVariantBefore = await currentDb.$queryRaw`SELECT "id", "currency", "priceMinor" FROM "ProductVariant" WHERE "productId" = ${phpStore.products[0].id}`;
    const usdOrder = await insertHistoricalOrder(currentDb, usdStore, `legacy-usd-${currentIdentity}`);
    const phpOrder = await insertHistoricalOrder(currentDb, phpStore, `legacy-php-${currentIdentity}`);

    const mixedStore = await insertLegacySellerAndStore(mixedDb, `legacy-mixed-${mixedIdentity}`, ['USD', 'PHP']);
    const mixedProductBefore = await mixedDb.$queryRaw`SELECT "id", "currency", "priceMinor" FROM "Product" WHERE "sellerId" = ${mixedStore.sellerId} ORDER BY "id"`;
    const mixedVariantStore = await insertLegacySellerAndStore(mixedDb, `legacy-mixed-variant-${mixedIdentity}`, ['USD']);
    await insertLegacyVariant(mixedDb, `legacy-mixed-variant-${mixedIdentity}`, mixedVariantStore.products[0], 'PHP');
    const mixedVariantBefore = await mixedDb.$queryRaw`SELECT variant."id", variant."currency", variant."priceMinor"
      FROM "ProductVariant" variant JOIN "Product" product ON product."id" = variant."productId"
      WHERE product."sellerId" = ${mixedVariantStore.sellerId} ORDER BY variant."id"`;

    const unsupportedFixtures = [];
    unsupportedFixtures.push(await insertLegacySellerAndStore(unsupportedDb, `legacy-inactive-${unsupportedIdentity}`, ['PHP']));
    unsupportedFixtures.push(await insertLegacySellerAndStore(unsupportedDb, `legacy-pricing-disabled-${unsupportedIdentity}`, ['EUR']));
    unsupportedFixtures.push(await insertLegacySellerAndStore(unsupportedDb, `legacy-lowercase-${unsupportedIdentity}`, ['php']));
    unsupportedFixtures.push(await insertLegacySellerAndStore(unsupportedDb, `legacy-uncatalogued-${unsupportedIdentity}`, ['ZZZ']));

    const currencyFoundationMigrations = names.filter(name => name > lastLegacy && name <= currencyFoundation);
    const remainingPreBackfillMigrations = names.filter(name => name > currencyFoundation && name <= lastPreviousFeature);
    for (const { db, tempDir, url: databaseUrl } of targets) {
      addMigrations(tempDir, currencyFoundationMigrations);
      expectDeploySuccess(tempDir, databaseUrl);
    }
    const explicitUsdOfferId = `explicit-usd-${currentIdentity}`;
    await currentDb.storeCurrencyOffer.create({ data: {
      id: explicitUsdOfferId, storeId: phpExplicitOfferStore.storeId, currency: 'USD',
      displayEnabled: true, checkoutEnabled: true
    } });
    for (const { tempDir, url: databaseUrl } of targets) {
      addMigrations(tempDir, remainingPreBackfillMigrations);
      expectDeploySuccess(tempDir, databaseUrl);
    }
    await currentDb.$executeRaw`UPDATE "CurrencyCatalogEntry" SET "displayEnabled" = FALSE WHERE "code" = 'PHP'`;
    await unsupportedDb.$executeRaw`UPDATE "CurrencyCatalogEntry" SET "active" = FALSE WHERE "code" = 'PHP'`;
    await unsupportedDb.$executeRaw`UPDATE "CurrencyCatalogEntry" SET "storePricingEnabled" = FALSE WHERE "code" = 'EUR'`;

    const legacyStoresBeforeBackfill = await currentDb.$queryRaw`SELECT "id", "baseCurrency" FROM "Store"
      WHERE "id" IN (${usdStore.storeId}, ${phpStore.storeId}, ${phpExplicitOfferStore.storeId}) ORDER BY "id"`;
    assert.deepEqual(legacyStoresBeforeBackfill.map(row => row.baseCurrency), ['USD', 'USD', 'USD'], 'Before migration 34, legacy Stores still have the schema-compatible USD default.');
    const existingUsdOffers = await currentDb.$queryRaw`SELECT "id", "storeId", "currency", "displayEnabled", "checkoutEnabled" FROM "StoreCurrencyOffer"
      WHERE "storeId" IN (${usdStore.storeId}, ${phpStore.storeId}, ${phpExplicitOfferStore.storeId}) AND "currency" = 'USD' ORDER BY "storeId"`;
    assert.equal(existingUsdOffers.length, 3, 'Migration 30 must create a generated USD offer and preserve a distinct explicit USD offer before migration 34.');
    assert.ok(existingUsdOffers.some(row => row.storeId === phpStore.storeId && row.id === `legacy-usd-${phpStore.storeId}`), 'Migration 30 must identify its generated legacy USD offer by the stable id.');
    assert.ok(existingUsdOffers.some(row => row.storeId === phpExplicitOfferStore.storeId && row.id === explicitUsdOfferId), 'The explicit USD offer must survive migration 30 unchanged.');
    const inferredOffersBeforeBackfill = await currentDb.$queryRaw`SELECT count(*)::int AS count FROM "StoreCurrencyOffer"
      WHERE "storeId" = ${phpStore.storeId} AND "currency" = 'PHP'`;
    assert.equal(inferredOffersBeforeBackfill[0]?.count, 0, 'The historical PHP offer is not expected until migration 34 runs.');

    const beforeMigrationOrderRows = await currentDb.$queryRaw`SELECT order_row."id", order_row."currency", order_row."totalMinor", payment."status" AS "paymentStatus", item."unitPriceMinor", item."quantity"
      FROM "ParentOrder" order_row JOIN "Payment" payment ON payment."parentId" = order_row."id"
      JOIN "SellerOrder" seller_order ON seller_order."parentId" = order_row."id"
      JOIN "OrderItem" item ON item."sellerOrderId" = seller_order."id"
      WHERE order_row."id" IN (${usdOrder.orderId}, ${phpOrder.orderId}) ORDER BY order_row."id"`;
    assert.deepEqual(beforeMigrationOrderRows.map(row => [row.id, row.currency, row.totalMinor, row.paymentStatus, row.unitPriceMinor, row.quantity]).sort(), [
      [usdOrder.orderId, 'USD', usdOrder.orderTotal, 'PENDING', usdOrder.unitPriceMinor, 2],
      [phpOrder.orderId, 'PHP', phpOrder.orderTotal, 'PENDING', phpOrder.unitPriceMinor, 2]
    ].sort(), 'The upgrade must retain historical order, payment, and item amounts/currencies exactly.');

    addMigrations(currentTemp, [currencyBackfill]);
    expectDeploySuccess(currentTemp, currentUrl);
    const legacyBase = await currentDb.$queryRaw`SELECT store."id", store."baseCurrency", offer."id" AS "offerId", offer."currency", offer."displayEnabled", offer."checkoutEnabled"
      FROM "Store" store JOIN "StoreCurrencyOffer" offer ON offer."storeId" = store."id"
      WHERE store."id" IN (${usdStore.storeId}, ${phpStore.storeId}, ${phpExplicitOfferStore.storeId}) ORDER BY store."id", offer."currency"`;
    const usdBase = legacyBase.find(row => row.id === usdStore.storeId && row.currency === 'USD');
    const phpBase = legacyBase.find(row => row.id === phpStore.storeId && row.currency === 'PHP');
    const generatedPhpUsd = legacyBase.find(row => row.id === phpStore.storeId && row.currency === 'USD');
    const explicitPhpBase = legacyBase.find(row => row.id === phpExplicitOfferStore.storeId && row.currency === 'PHP');
    const explicitPhpUsd = legacyBase.find(row => row.id === phpExplicitOfferStore.storeId && row.currency === 'USD');
    assert.deepEqual([usdBase?.baseCurrency, usdBase?.displayEnabled, usdBase?.checkoutEnabled], ['USD', true, true]);
    assert.deepEqual([phpBase?.baseCurrency, phpBase?.displayEnabled, phpBase?.checkoutEnabled], ['PHP', false, false], 'Historical PHP pricing is preserved without enabling a platform-disabled display or unsupported checkout capability.');
    assert.deepEqual([generatedPhpUsd?.offerId, generatedPhpUsd?.baseCurrency, generatedPhpUsd?.displayEnabled, generatedPhpUsd?.checkoutEnabled], [`legacy-usd-${phpStore.storeId}`, 'PHP', true, false], 'The exact migration-30-generated USD offer remains but cannot enable checkout after PHP inference.');
    assert.deepEqual([explicitPhpBase?.baseCurrency, explicitPhpBase?.displayEnabled, explicitPhpBase?.checkoutEnabled], ['PHP', false, false]);
    assert.deepEqual([explicitPhpUsd?.offerId, explicitPhpUsd?.baseCurrency, explicitPhpUsd?.displayEnabled, explicitPhpUsd?.checkoutEnabled], [explicitUsdOfferId, 'PHP', true, true], 'Migration 34 must not rewrite a pre-existing explicit offer.');
    const allApplied = await currentDb.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`;
    assert.equal(allApplied[0]?.count, names.length, 'The compatible upgrade must finish every migration in order.');
    const persistedOrders = await currentDb.$queryRaw`SELECT order_row."id", order_row."currency", order_row."totalMinor", payment."status" AS "paymentStatus", item."unitPriceMinor", item."quantity"
      FROM "ParentOrder" order_row JOIN "Payment" payment ON payment."parentId" = order_row."id"
      JOIN "SellerOrder" seller_order ON seller_order."parentId" = order_row."id"
      JOIN "OrderItem" item ON item."sellerOrderId" = seller_order."id"
      WHERE order_row."id" IN (${usdOrder.orderId}, ${phpOrder.orderId}) ORDER BY order_row."id"`;
    assert.deepEqual(persistedOrders.map(row => [row.id, row.currency, row.totalMinor, row.paymentStatus, row.unitPriceMinor, row.quantity]).sort(), beforeMigrationOrderRows.map(row => [row.id, row.currency, row.totalMinor, row.paymentStatus, row.unitPriceMinor, row.quantity]).sort());
    const phpVariantAfter = await currentDb.$queryRaw`SELECT "id", "currency", "priceMinor" FROM "ProductVariant" WHERE "productId" = ${phpStore.products[0].id}`;
    assert.deepEqual(phpVariantAfter, phpVariantBefore, 'The upgrade must preserve historical variant amounts and currencies exactly.');

    await verifyPublicCheckoutCompatibility(currentDb, phpExplicitOfferStore, phpExplicitOfferStore.products[0], currentUrl, currentIdentity, currentTemp);

    addMigrations(mixedTemp, [currencyBackfill]);
    const mixedFailure = deploy(mixedTemp, mixedUrl);
    assert.equal(mixedFailure.error, undefined, `Prisma mixed-currency preflight could not start: ${mixedFailure.error?.message ?? ''}`);
    assert.notEqual(mixedFailure.status, 0, 'Mixed-currency legacy Stores must stop the upgrade instead of selecting a currency.');
    assert.match(mixedFailure.output, /Store currency backfill aborted: 2 Store\(s\) contain product or variant pricing in multiple currencies/i);
    const mixedStoreAfter = await mixedDb.$queryRaw`SELECT "baseCurrency" FROM "Store" WHERE "id" = ${mixedStore.storeId}`;
    assert.equal(mixedStoreAfter[0]?.baseCurrency, 'USD', 'The failed preflight must not partially change Store currency.');
    const mixedVariantStoreAfter = await mixedDb.$queryRaw`SELECT "baseCurrency" FROM "Store" WHERE "id" = ${mixedVariantStore.storeId}`;
    assert.equal(mixedVariantStoreAfter[0]?.baseCurrency, 'USD', 'The failed preflight must not partially change a Store with conflicting product and variant currencies.');
    const mixedProductsAfter = await mixedDb.$queryRaw`SELECT "id", "currency", "priceMinor" FROM "Product" WHERE "sellerId" = ${mixedStore.sellerId} ORDER BY "id"`;
    assert.deepEqual(mixedProductsAfter, mixedProductBefore, 'The failed preflight must not alter historical product prices or currencies.');
    const mixedVariantAfter = await mixedDb.$queryRaw`SELECT variant."id", variant."currency", variant."priceMinor"
      FROM "ProductVariant" variant JOIN "Product" product ON product."id" = variant."productId"
      WHERE product."sellerId" = ${mixedVariantStore.sellerId} ORDER BY variant."id"`;
    assert.deepEqual(mixedVariantAfter, mixedVariantBefore, 'The preflight must not alter historical variant amounts or currencies.');
    const mixedOffersAfter = await mixedDb.$queryRaw`SELECT count(*)::int AS count FROM "StoreCurrencyOffer" WHERE "storeId" IN (${mixedStore.storeId}, ${mixedVariantStore.storeId}) AND "id" LIKE 'legacy-base-%'`;
    assert.equal(mixedOffersAfter[0]?.count, 0, 'The preflight must fail before adding inferred offers for mixed product or variant currencies.');
    const failedMigration = await mixedDb.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "migration_name" = ${currencyBackfill} AND "finished_at" IS NULL AND "rolled_back_at" IS NULL`;
    assert.equal(failedMigration[0]?.count, 1, 'Prisma records the failed migration for operator review; the disposable DB is not retried.');

    const unsupportedProductsBefore = await unsupportedDb.$queryRaw`SELECT "id", "sellerId", "currency", "priceMinor" FROM "Product" ORDER BY "sellerId", "id"`;
    assert.equal(unsupportedProductsBefore.length, 4, 'The fixture includes inactive, store-pricing-disabled, lowercase, and uncatalogued legacy pricing.');
    const unsupportedStoreIds = unsupportedFixtures.map(fixture => fixture.storeId);
    const unsupportedStoresBefore = await unsupportedDb.$queryRaw`SELECT "id", "baseCurrency" FROM "Store" WHERE "id" IN (${Prisma.join(unsupportedStoreIds)}) ORDER BY "id"`;
    const unsupportedOffersBefore = await unsupportedDb.$queryRaw`SELECT "id", "storeId", "currency", "displayEnabled", "checkoutEnabled" FROM "StoreCurrencyOffer" WHERE "storeId" IN (${Prisma.join(unsupportedStoreIds)}) ORDER BY "storeId", "currency"`;
    assert.equal(unsupportedOffersBefore.length, 4, 'Migration 30 generated one USD offer per unsupported legacy Store before migration 34.');
    addMigrations(unsupportedTemp, [currencyBackfill]);
    const unsupportedFailure = deploy(unsupportedTemp, unsupportedUrl);
    assert.equal(unsupportedFailure.error, undefined, `Prisma unsupported-pricing preflight could not start: ${unsupportedFailure.error?.message ?? ''}`);
    assert.notEqual(unsupportedFailure.status, 0, 'Unsupported legacy pricing must stop migration 34.');
    assert.match(unsupportedFailure.output, /Store currency backfill aborted: 4 product or variant pricing row\(s\) use a currency not available for Store pricing/i);
    const unsupportedStoresAfter = await unsupportedDb.$queryRaw`SELECT "id", "baseCurrency" FROM "Store" WHERE "id" IN (${Prisma.join(unsupportedStoreIds)}) ORDER BY "id"`;
    assert.deepEqual(unsupportedStoresAfter, unsupportedStoresBefore, 'Failed unsupported-pricing preflight must preserve Store currency fields.');
    const unsupportedOffersAfter = await unsupportedDb.$queryRaw`SELECT "id", "storeId", "currency", "displayEnabled", "checkoutEnabled" FROM "StoreCurrencyOffer" WHERE "storeId" IN (${Prisma.join(unsupportedStoreIds)}) ORDER BY "storeId", "currency"`;
    assert.deepEqual(unsupportedOffersAfter, unsupportedOffersBefore, 'Failed unsupported-pricing preflight must preserve generated legacy offers.');
    const unsupportedProductsAfter = await unsupportedDb.$queryRaw`SELECT "id", "sellerId", "currency", "priceMinor" FROM "Product" ORDER BY "sellerId", "id"`;
    assert.deepEqual(unsupportedProductsAfter, unsupportedProductsBefore, 'Failed preflight must preserve legacy product currencies and amounts.');
    const unsupportedFailedMigration = await unsupportedDb.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE "migration_name" = ${currencyBackfill} AND "finished_at" IS NULL AND "rolled_back_at" IS NULL`;
    assert.equal(unsupportedFailedMigration[0]?.count, 1, 'Prisma leaves the failed migration visible for operator review without partial backfill.');
  } finally {
    await currentDb.$disconnect();
    await mixedDb.$disconnect();
    await unsupportedDb.$disconnect();
    rmSync(currentTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    rmSync(mixedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    rmSync(unsupportedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
