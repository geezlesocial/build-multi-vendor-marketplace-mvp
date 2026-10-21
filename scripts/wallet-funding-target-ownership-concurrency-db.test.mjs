import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { validateE2EDatabaseURL } from './e2e-database-url.mjs';

const databaseUrl = process.env.WALLET_FUNDING_TARGET_OWNERSHIP_TEST_DATABASE_URL;
const sandboxId = process.env.WALLET_FUNDING_SANDBOX_ID;
if (!databaseUrl || !sandboxId) throw new Error('A fresh per-run wallet funding ownership database is required');
const target = validateE2EDatabaseURL(databaseUrl);
if (!/^[a-f0-9]{32}$/.test(sandboxId) || target.databaseName !== `wallet_funding_test_${sandboxId}`) {
  throw new Error('Wallet funding ownership concurrency test requires the exact fresh per-run database identity');
}

process.env.DOTENV_CONFIG_PATH = 'C:\\wallet-funding-test-env-file-must-not-exist';
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';

const { PrismaClient } = await import('@prisma/client');
const clientA = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const clientB = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const monitor = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function capture(promise) {
  return promise.then(
    value => ({ state: 'fulfilled', value }),
    error => ({ state: 'rejected', error })
  );
}

async function identifyConnection(tx, label) {
  const rows = await tx.$queryRaw`SELECT pg_backend_pid() AS pid, set_config('application_name', ${label}, true) AS app`;
  return Number(rows[0].pid);
}

async function assertBlockedOnLock(pid, settled, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const completed = await Promise.race([settled.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(completed, false, `${label} completed before acquiring the competing wallet lock`);
    const rows = await monitor.$queryRaw`
      SELECT state, wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE pid = ${pid}
    `;
    if (rows[0]?.state === 'active' && rows[0]?.waitEventType === 'Lock') return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`${label} did not enter a PostgreSQL lock wait`);
}

async function createTarget(label) {
  const unique = `${label}-${randomBytes(8).toString('hex')}`;
  const user = await monitor.user.create({
    data: { email: `${unique}@example.test`, name: 'Synthetic lock-test user', role: 'BUYER', passwordHash: 'synthetic-only' }
  });
  const account = await monitor.walletAccount.create({ data: { userId: user.id, type: 'USER' } });
  return { userId: user.id, accountId: account.id, unique };
}

async function createIntent(tx, target, suffix) {
  return tx.walletFundingIntent.create({
    data: {
      userId: target.userId,
      accountId: target.accountId,
      amountMinor: 100,
      currency: 'USD',
      provider: 'STRIPE',
      idempotencyKey: `ownership-lock-${target.unique}-${suffix}`
    }
  });
}

async function assertNoInvalidFundingTargets() {
  const rows = await monitor.$queryRaw`
    SELECT count(*)::int AS count
    FROM "WalletFundingIntent" intent
    JOIN "WalletAccount" account ON account."id" = intent."accountId"
    WHERE account."userId" IS DISTINCT FROM intent."userId"
       OR account."type" <> 'USER'
  `;
  assert.equal(rows[0].count, 0, 'database contains a funding intent targeting another owner or a non-USER wallet');
}

test('wallet ownership triggers serialize intent creation and wallet type changes in either order', async () => {
  try {
    // Interleaving 1: INSERT's BEFORE trigger locks the USER wallet first.
    const insertFirst = await createTarget('ownership-insert-first');
    const inserted = deferred();
    const releaseInsert = deferred();
    const insertTransaction = clientA.$transaction(async tx => {
      const pid = await identifyConnection(tx, `wallet-lock-insert-first-${insertFirst.unique}`);
      const intent = await createIntent(tx, insertFirst, 'insert-first');
      inserted.resolve({ pid, intentId: intent.id });
      await releaseInsert.promise;
    });
    const insertOutcome = capture(insertTransaction);
    const insertReady = await Promise.race([
      inserted.promise.then(value => ({ state: 'ready', value })),
      insertOutcome.then(outcome => ({ state: 'settled', outcome }))
    ]);
    assert.equal(insertReady.state, 'ready', 'intent insert must reach its trigger before the competing update starts');
    const { pid: insertPid, intentId } = insertReady.value;

    const updatePidReady = deferred();
    const releaseUpdate = deferred();
    const updateTransaction = clientB.$transaction(async tx => {
      const pid = await identifyConnection(tx, `wallet-lock-update-after-insert-${insertFirst.unique}`);
      updatePidReady.resolve(pid);
      await tx.walletAccount.update({ where: { id: insertFirst.accountId }, data: { type: 'TREASURY', userId: null } });
      await releaseUpdate.promise;
    });
    const updateOutcome = capture(updateTransaction);
    const updatePid = await updatePidReady.promise;
    assert.notEqual(insertPid, updatePid, 'interleaving must use independent PostgreSQL connections');
    try {
      await assertBlockedOnLock(updatePid, updateOutcome, 'wallet type update after intent insert');
    } finally {
      releaseInsert.resolve();
    }
    await insertOutcome;
    const firstUpdateResult = await updateOutcome;
    assert.equal(firstUpdateResult.state, 'rejected', 'wallet type change must fail after the committed intent exists');
    const firstState = await monitor.walletAccount.findUniqueOrThrow({ where: { id: insertFirst.accountId } });
    assert.equal(firstState.type, 'USER');
    assert.equal(await monitor.walletFundingIntent.count({ where: { id: intentId } }), 1);
    const alternateTarget = await createTarget('ownership-target-change');
    await assert.rejects(() => monitor.walletFundingIntent.update({
      where: { id: intentId },
      data: { userId: alternateTarget.userId, accountId: alternateTarget.accountId }
    }), /immutable/i);
    await assertNoInvalidFundingTargets();

    // Interleaving 2: wallet UPDATE locks the row first; INSERT must then see
    // the committed TREASURY type and reject instead of creating an intent.
    const updateFirst = await createTarget('ownership-update-first');
    const walletUpdated = deferred();
    const releaseWalletUpdate = deferred();
    const walletUpdateTransaction = clientB.$transaction(async tx => {
      const walletPid = await identifyConnection(tx, `wallet-lock-update-first-${updateFirst.unique}`);
      await tx.walletAccount.update({ where: { id: updateFirst.accountId }, data: { type: 'TREASURY', userId: null } });
      walletUpdated.resolve(walletPid);
      await releaseWalletUpdate.promise;
    });
    const walletUpdateOutcome = capture(walletUpdateTransaction);
    const walletReady = await Promise.race([
      walletUpdated.promise.then(pid => ({ state: 'ready', pid })),
      walletUpdateOutcome.then(outcome => ({ state: 'settled', outcome }))
    ]);
    assert.equal(walletReady.state, 'ready', 'wallet update must hold its row before the competing insert starts');
    const walletPid = walletReady.pid;

    const intentPidReady = deferred();
    const intentTransaction = clientA.$transaction(async tx => {
      const pid = await identifyConnection(tx, `wallet-lock-insert-after-update-${updateFirst.unique}`);
      intentPidReady.resolve(pid);
      await createIntent(tx, updateFirst, 'update-first');
    });
    const intentOutcome = capture(intentTransaction);
    const intentPid = await intentPidReady.promise;
    assert.notEqual(intentPid, walletPid, 'interleaving must use independent PostgreSQL connections');
    try {
      await assertBlockedOnLock(intentPid, intentOutcome, 'intent insert after wallet type update');
    } finally {
      releaseWalletUpdate.resolve();
    }
    const walletUpdateResult = await walletUpdateOutcome;
    assert.equal(walletUpdateResult.state, 'fulfilled');
    const secondIntentResult = await intentOutcome;
    assert.equal(secondIntentResult.state, 'rejected', 'intent insert must fail after the wallet becomes TREASURY');
    const secondState = await monitor.walletAccount.findUniqueOrThrow({ where: { id: updateFirst.accountId } });
    assert.equal(secondState.type, 'TREASURY');
    assert.equal(await monitor.walletFundingIntent.count({ where: { accountId: updateFirst.accountId } }), 0);
    await assertNoInvalidFundingTargets();
  } finally {
    await Promise.all([clientA.$disconnect(), clientB.$disconnect(), monitor.$disconnect()]);
  }
});
