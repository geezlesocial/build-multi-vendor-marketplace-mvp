import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ClubCoinEntryType, Prisma, Role, WalletAccountStatus, WalletAccountType, WalletLedgerEntryType, WalletLedgerStatus, WalletPostingDirection, WalletTransferStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { assertBalancedPostings, assertCoinEntry, assertTransferAllowed, currencyCodeSchema, isWalletActionEnabled, positiveMinorSchema, publicWalletStatus } from './wallet-domain.js';
import { appendWalletAllocations, buildPostingAllocations } from './wallet-ledger.js';
import { buildWalletReconciliationReport } from './wallet-reconciliation.js';
import { createWalletFundingPayment, getStripeWalletFundingProvider, persistWalletFundingProviderReference, processWalletFundingEvent, recoverWalletFundingPaymentIntent, validateWalletFundingPaymentIntent, walletFundingSandboxEnabled, WalletFundingRetryableError } from './wallet-funding.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const requireWalletFundingSandbox: express.RequestHandler = (_req, res, next) => {
  if (!walletFundingSandboxEnabled()) return res.status(409).json({ error: 'Wallet funding is restricted to an explicit disposable sandbox configuration' });
  next();
};
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const inputJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const isUniqueConstraintError = (error: unknown): error is Prisma.PrismaClientKnownRequestError => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const transferSchema = z.object({ recipientEmail: z.string().email(), amountMinor: positiveMinorSchema, currency: currencyCodeSchema, idempotencyKey: z.string().trim().min(8).max(120) });
const fundingSchema = z.object({ amountMinor: positiveMinorSchema, currency: currencyCodeSchema, provider: z.string().trim().min(2).max(60), idempotencyKey: z.string().trim().min(8).max(120) });
const withdrawalSchema = z.object({ amountMinor: positiveMinorSchema, currency: currencyCodeSchema, payoutMethodId: z.string().cuid().optional(), destinationType: z.enum(['APPROVED_PAYOUT_METHOD']), idempotencyKey: z.string().trim().min(8).max(120) });
const walletSettingsSchema = z.object({
  walletEnabled: z.boolean().optional(),
  walletFundingEnabled: z.boolean().optional(),
  walletTransfersEnabled: z.boolean().optional(),
  walletCheckoutEnabled: z.boolean().optional(),
  walletWithdrawalsEnabled: z.boolean().optional(),
  walletEmergencyPause: z.boolean().optional(),
  clubCoinsEnabled: z.boolean().optional(),
  clubCoinsEarnEnabled: z.boolean().optional(),
  clubCoinsRedeemEnabled: z.boolean().optional(),
  clubCoinTransfersEnabled: z.boolean().optional(),
  clubCoinConversionEnabled: z.boolean().optional(),
  clubCoinRedemptionRatio: z.number().int().positive().max(1_000_000).optional(),
  clubCoinMaxDiscountMinor: z.number().int().nonnegative().max(2_000_000_000).optional(),
  clubCoinName: z.string().trim().min(2).max(50).optional(),
  clubCoinIconUrl: z.string().url().max(2000).nullable().optional(),
  reason: z.string().trim().min(1).max(500)
});
const ruleSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9._-]{2,80}$/),
  eventType: z.enum(['ACCOUNT_VERIFIED', 'PURCHASE_COMPLETED', 'REVIEW_SUBMITTED', 'LIVE_ATTENDANCE', 'CUSTOM']),
  enabled: z.boolean().default(false),
  awardAmount: z.number().int().positive().max(1_000_000),
  perUserCap: z.number().int().positive().optional().nullable(),
  perOrderCap: z.number().int().positive().optional().nullable(),
  dailyCap: z.number().int().positive().optional().nullable(),
  expiresAfterDays: z.number().int().positive().max(3650).optional().nullable(),
  effectiveFrom: z.string().datetime().optional().nullable(),
  effectiveTo: z.string().datetime().optional().nullable(),
  eligibleGroups: z.array(z.string().trim().min(1).max(80)).max(50).optional().nullable()
});
const coinAdjustmentSchema = z.object({ userId: z.string().cuid(), amount: z.number().int().refine(value => value !== 0, 'Adjustment cannot be zero').max(1_000_000).min(-1_000_000), reason: z.string().trim().min(3).max(500), reference: z.string().trim().min(1).max(160), idempotencyKey: z.string().trim().min(8).max(120) });

export type ClubCoinAdjustmentInput = z.infer<typeof coinAdjustmentSchema>;

type WalletSettings = {
  walletEnabled: boolean;
  walletFundingEnabled: boolean;
  walletTransfersEnabled: boolean;
  walletCheckoutEnabled: boolean;
  walletWithdrawalsEnabled: boolean;
  walletEmergencyPause: boolean;
};

function actor(res: Response) { return res.locals.user as { id: string; role: Role }; }

export const walletAudit = {
  async write(tx: Prisma.TransactionClient, actorId: string | undefined, action: string, entity: string, entityId: string | undefined, metadata?: unknown) {
    await tx.auditLog.create({ data: { actorId, action, entity, entityId, metadata: metadata as object | undefined } });
  }
};

async function auditInTransaction(tx: Prisma.TransactionClient, actorId: string | undefined, action: string, entity: string, entityId: string | undefined, metadata?: unknown) {
  await walletAudit.write(tx, actorId, action, entity, entityId, metadata);
}

async function settings() {
  return prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
}

function walletGateSettings(value: WalletSettings): WalletSettings { return value; }

function walletSummary(settingsValue: Awaited<ReturnType<typeof settings>>) {
  return {
    walletEnabled: settingsValue.walletEnabled,
    walletFundingEnabled: isWalletActionEnabled('walletFundingEnabled', walletGateSettings(settingsValue), env.MONEY_MOVEMENT_HARD_DISABLED) && env.WALLET_FUNDING_PROVIDER_READY,
    walletTransfersEnabled: isWalletActionEnabled('walletTransfersEnabled', walletGateSettings(settingsValue), env.MONEY_MOVEMENT_HARD_DISABLED),
    walletCheckoutEnabled: isWalletActionEnabled('walletCheckoutEnabled', walletGateSettings(settingsValue), env.MONEY_MOVEMENT_HARD_DISABLED),
    walletWithdrawalsEnabled: isWalletActionEnabled('walletWithdrawalsEnabled', walletGateSettings(settingsValue), env.MONEY_MOVEMENT_HARD_DISABLED),
    walletEmergencyPause: settingsValue.walletEmergencyPause,
    moneyMovementHardDisabled: env.MONEY_MOVEMENT_HARD_DISABLED,
    walletFundingProviderReady: env.WALLET_FUNDING_PROVIDER_READY,
    clubCoinsEnabled: settingsValue.clubCoinsEnabled && !env.CLUB_COINS_HARD_DISABLED,
    clubCoinsEarnEnabled: settingsValue.clubCoinsEarnEnabled && settingsValue.clubCoinsEnabled && !env.CLUB_COINS_HARD_DISABLED,
    clubCoinsRedeemEnabled: settingsValue.clubCoinsRedeemEnabled && settingsValue.clubCoinsEnabled && !env.CLUB_COINS_HARD_DISABLED,
    clubCoinTransfersEnabled: settingsValue.clubCoinTransfersEnabled && settingsValue.clubCoinsEnabled && !env.CLUB_COINS_HARD_DISABLED,
    clubCoinConversionEnabled: settingsValue.clubCoinConversionEnabled && settingsValue.clubCoinsEnabled && !env.CLUB_COINS_HARD_DISABLED,
    clubCoinsHardDisabled: env.CLUB_COINS_HARD_DISABLED,
    clubCoinName: settingsValue.clubCoinName,
    clubCoinRedemptionRatio: settingsValue.clubCoinRedemptionRatio,
    clubCoinMaxDiscountMinor: settingsValue.clubCoinMaxDiscountMinor
  };
}

async function userAccount(userId: string) {
  return prisma.walletAccount.findUnique({ where: { userId }, include: { balances: { orderBy: { currency: 'asc' } } } });
}

async function userCoinAccount(userId: string) {
  return prisma.clubCoinAccount.findUnique({ where: { userId } });
}

async function ensureWalletAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.walletAccount.upsert({ where: { userId }, update: {}, create: { userId, type: WalletAccountType.USER } });
}

async function ensureWalletBalance(tx: Prisma.TransactionClient, accountId: string, currency: string) {
  return tx.walletBalance.upsert({ where: { accountId_currency: { accountId, currency } }, update: {}, create: { accountId, currency } });
}

async function ensureCoinAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.clubCoinAccount.upsert({ where: { userId }, update: {}, create: { userId } });
}

function adjustmentMatches(entry: { userId: string; amount: number; referenceId: string | null; reason: string | null }, input: ClubCoinAdjustmentInput) {
  return entry.userId === input.userId && entry.amount === input.amount && entry.referenceId === input.reference && entry.reason === input.reason;
}

function fundingIntentMatches(intent: { userId: string; amountMinor: number; currency: string; provider: string }, userId: string, input: { amountMinor: number; currency: string; provider: string }) {
  return intent.userId === userId && intent.amountMinor === input.amountMinor && intent.currency === input.currency && intent.provider === input.provider;
}

function fundingRecoveryExpectation(intent: { id: string; userId: string; providerIntentId: string | null; idempotencyKey: string; amountMinor: number; currency: string }, requestingUserId: string) {
  if (!intent.providerIntentId) throw fail(503, 'Sandbox funding payment is not ready; retry the same idempotent request');
  return {
    requestingUserId,
    fundingIntentId: intent.id,
    userId: intent.userId,
    providerIntentId: intent.providerIntentId,
    idempotencyKey: intent.idempotencyKey,
    amountMinor: intent.amountMinor,
    currency: intent.currency
  };
}

function validateCreatedFundingPayment(intent: { id: string; userId: string; providerIntentId?: string | null; idempotencyKey: string; amountMinor: number; currency: string }, userId: string, payment: Awaited<ReturnType<typeof createWalletFundingPayment>>) {
  try {
    return validateWalletFundingPaymentIntent({
      requestingUserId: userId,
      fundingIntentId: intent.id,
      userId: intent.userId,
      providerIntentId: payment.providerIntentId,
      idempotencyKey: intent.idempotencyKey,
      amountMinor: intent.amountMinor,
      currency: intent.currency
    }, payment);
  } catch {
    throw fail(503, 'Sandbox funding payment could not be safely validated; retry the same request or contact support');
  }
}

async function recoverFundingPayment(intent: { id: string; userId: string; providerIntentId: string | null; idempotencyKey: string; amountMinor: number; currency: string; status: string }, userId: string) {
  if (intent.userId !== userId) throw fail(404, 'Funding intent is unavailable');
  if (intent.status !== 'PENDING' && intent.status !== 'FAILED') return null;
  if (!intent.providerIntentId) return null;
  const provider = getStripeWalletFundingProvider();
  if (!provider) throw fail(503, 'Sandbox funding payment cannot be recovered right now; retry the same request');
  try {
    return await recoverWalletFundingPaymentIntent(fundingRecoveryExpectation(intent, userId), provider);
  } catch {
    throw fail(503, 'Sandbox funding payment could not be safely recovered; retry the same request or contact support');
  }
}

function transferMatches(transfer: { senderId: string; recipientId: string; amountMinor: number; currency: string }, userId: string, recipientId: string, input: { amountMinor: number; currency: string }) {
  return transfer.senderId === userId && transfer.recipientId === recipientId && transfer.amountMinor === input.amountMinor && transfer.currency === input.currency;
}

export async function applyClubCoinAdjustment(currentActorId: string, input: ClubCoinAdjustmentInput) {
  const idempotencyKey = `admin-adjustment:${currentActorId}:${input.idempotencyKey}`;
  const execute = () => prisma.$transaction(async tx => {
    const existing = await tx.clubCoinEntry.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (!adjustmentMatches(existing, input)) throw fail(409, 'Idempotency key was already used for a different Club Coin adjustment');
      return { entry: existing, created: false };
    }

    const account = await ensureCoinAccount(tx, input.userId);
    if (account.status !== 'ACTIVE') throw fail(409, 'Club Coin account is frozen');
    assertCoinEntry({ amount: input.amount, balance: account.balance, allowNegative: true });
    const update = input.amount < 0
      ? await tx.clubCoinAccount.updateMany({ where: { id: account.id, balance: { gte: Math.abs(input.amount) } }, data: { balance: { decrement: Math.abs(input.amount) } } })
      : await tx.clubCoinAccount.updateMany({ where: { id: account.id }, data: { balance: { increment: input.amount } } });
    if (update.count !== 1) throw fail(409, 'Club Coin balance is insufficient for this adjustment');
    const entry = await tx.clubCoinEntry.create({ data: { accountId: account.id, userId: input.userId, entryType: ClubCoinEntryType.ADJUSTMENT, amount: input.amount, idempotencyKey, referenceType: 'ADMIN_ADJUSTMENT', referenceId: input.reference, reason: input.reason } });
    await auditInTransaction(tx, currentActorId, 'CLUB_COINS_MANUAL_ADJUSTMENT', 'ClubCoinEntry', entry.id, { userId: input.userId, amount: input.amount, reference: input.reference, reason: input.reason, idempotencyKey: input.idempotencyKey });
    return { entry, created: true };
  });

  try {
    return await execute();
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.clubCoinEntry.findUnique({ where: { idempotencyKey } });
    if (!existing) throw error;
    if (!adjustmentMatches(existing, input)) throw fail(409, 'Idempotency key was already used for a different Club Coin adjustment');
    return { entry: existing, created: false };
  }
}

export function registerWalletRoutes(app: Express) {
  app.get('/api/wallet', requireAuth, run(async (_req, res) => {
    const user = actor(res);
    const [account, setting] = await Promise.all([userAccount(user.id), settings()]);
    const postings = account ? await prisma.walletLedgerPosting.findMany({ where: { accountId: account.id }, include: { transaction: true }, orderBy: { createdAt: 'desc' }, take: 100 }) : [];
    res.json({
      account: account ? { id: account.id, status: account.status, balances: account.balances.map(balance => ({ currency: balance.currency, availableMinor: balance.availableMinor, pendingMinor: balance.pendingMinor, heldMinor: balance.heldMinor, frozenMinor: balance.frozenMinor })) } : { status: 'ACTIVE', balances: [] },
      transactions: postings.map(posting => ({ id: posting.id, amountMinor: posting.amountMinor, direction: posting.direction, currency: posting.currency, status: publicWalletStatus(posting.transaction.status), type: posting.transaction.entryType, referenceType: posting.transaction.referenceType, referenceId: posting.transaction.referenceId, createdAt: posting.createdAt })),
      gates: walletSummary(setting)
    });
  }));

  app.get('/api/wallet/transactions', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const account = await userAccount(user.id);
    if (!account) return res.json({ items: [] });
    const take = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const postings = await prisma.walletLedgerPosting.findMany({ where: { accountId: account.id }, include: { transaction: true }, orderBy: { createdAt: 'desc' }, take });
    res.json({ items: postings.map(posting => ({ id: posting.id, amountMinor: posting.amountMinor, direction: posting.direction, currency: posting.currency, status: posting.transaction.status, type: posting.transaction.entryType, referenceType: posting.transaction.referenceType, referenceId: posting.transaction.referenceId, createdAt: posting.createdAt })) });
  }));

  app.post('/api/wallet/funding-intents', requireWalletFundingSandbox, requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = fundingSchema.parse(req.body);
    const setting = await settings();
    if (!env.WALLET_FUNDING_PROVIDER_READY || !isWalletActionEnabled('walletFundingEnabled', walletGateSettings(setting), env.MONEY_MOVEMENT_HARD_DISABLED)) throw fail(409, 'Wallet funding is disabled until an approved provider and settlement policy are configured');
    if (input.provider !== 'STRIPE') throw fail(400, 'Only the approved Stripe sandbox provider is supported');
    const existing = await prisma.walletFundingIntent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (!fundingIntentMatches(existing, user.id, input)) throw fail(409, 'Idempotency key was already used for a different request');
      const recovered = await recoverFundingPayment(existing, user.id);
      if (recovered) return res.status(200).json({ id: existing.id, status: existing.status, provider: existing.provider, providerIntentId: recovered.providerIntentId, clientSecret: recovered.clientSecret, message: 'Continue the existing sandbox payment; provider confirmation is still required' });
      if (existing.status !== 'PENDING' && existing.status !== 'FAILED') return res.status(200).json({ id: existing.id, status: existing.status, provider: existing.provider, providerIntentId: existing.providerIntentId });
      let providerPayment;
      try {
        providerPayment = await createWalletFundingPayment({ fundingIntentId: existing.id, userId: existing.userId, idempotencyKey: input.idempotencyKey, amountMinor: existing.amountMinor, currency: existing.currency });
      } catch {
        throw fail(503, 'Sandbox funding provider is temporarily unavailable; retry the same idempotent request');
      }
      validateCreatedFundingPayment(existing, user.id, providerPayment);
      let updated;
      try {
        updated = await persistWalletFundingProviderReference(existing.id, providerPayment.providerIntentId) as typeof existing;
      } catch {
        throw fail(503, 'Provider intent was created; retry the same idempotent request to persist its reference');
      }
      return res.status(200).json({ id: updated.id, status: updated.status, provider: updated.provider, providerIntentId: updated.providerIntentId, clientSecret: providerPayment.clientSecret, message: 'Funding intent created; provider confirmation is still required' });
    }
    try {
      const intent = await prisma.$transaction(async tx => {
        const account = await ensureWalletAccount(tx, user.id);
        return tx.walletFundingIntent.create({ data: { userId: user.id, accountId: account.id, amountMinor: input.amountMinor, currency: input.currency, provider: input.provider, idempotencyKey: input.idempotencyKey } });
      });
      let providerPayment;
      try {
        providerPayment = await createWalletFundingPayment({ fundingIntentId: intent.id, userId: intent.userId, idempotencyKey: input.idempotencyKey, amountMinor: intent.amountMinor, currency: intent.currency });
      } catch {
        throw fail(503, 'Sandbox funding provider is temporarily unavailable; retry the same idempotent request');
      }
      validateCreatedFundingPayment(intent, user.id, providerPayment);
      let updated;
      try {
        updated = await persistWalletFundingProviderReference(intent.id, providerPayment.providerIntentId) as typeof intent;
      } catch {
        throw fail(503, 'Provider intent was created; retry the same idempotent request to persist its reference');
      }
      return res.status(201).json({ id: updated.id, status: updated.status, provider: updated.provider, providerIntentId: updated.providerIntentId, clientSecret: providerPayment.clientSecret, message: 'Funding intent created; provider confirmation is still required' });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await prisma.walletFundingIntent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!raced) throw error;
      if (!fundingIntentMatches(raced, user.id, input)) throw fail(409, 'Idempotency key was already used for a different request');
      const recovered = await recoverFundingPayment(raced, user.id);
      return res.status(200).json({ id: raced.id, status: raced.status, provider: raced.provider, providerIntentId: recovered?.providerIntentId ?? raced.providerIntentId, ...(recovered ? { clientSecret: recovered.clientSecret, message: 'Continue the existing sandbox payment; provider confirmation is still required' } : {}) });
    }
  }));

  app.post('/api/wallet/transfers', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = transferSchema.parse(req.body);
    const setting = await settings();
    if (!isWalletActionEnabled('walletTransfersEnabled', walletGateSettings(setting), env.MONEY_MOVEMENT_HARD_DISABLED)) throw fail(409, 'Wallet transfers are disabled');
    const recipient = await prisma.user.findUnique({ where: { email: input.recipientEmail.toLowerCase() }, select: { id: true } });
    if (!recipient || recipient.id === user.id) throw fail(409, 'Transfer recipient is not eligible');
    const existing = await prisma.walletTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (!transferMatches(existing, user.id, recipient.id, input)) throw fail(409, 'Idempotency key was already used for a different request');
      return res.status(200).json({ id: existing.id, status: existing.status });
    }
    try {
      const transfer = await prisma.$transaction(async tx => {
        const sourceAccount = await ensureWalletAccount(tx, user.id);
        const destinationAccount = await ensureWalletAccount(tx, recipient.id);
        if (sourceAccount.status !== WalletAccountStatus.ACTIVE || destinationAccount.status !== WalletAccountStatus.ACTIVE) throw fail(409, 'Wallet transfer is unavailable');
        const sourceBalance = await ensureWalletBalance(tx, sourceAccount.id, input.currency);
        const destinationBalance = await ensureWalletBalance(tx, destinationAccount.id, input.currency);
        assertTransferAllowed({ senderId: user.id, recipientId: recipient.id, amountMinor: input.amountMinor, currency: input.currency }, sourceBalance.availableMinor, walletGateSettings(setting), env.MONEY_MOVEMENT_HARD_DISABLED);
        const debit = await tx.walletBalance.updateMany({ where: { id: sourceBalance.id, availableMinor: { gte: input.amountMinor } }, data: { availableMinor: { decrement: input.amountMinor } } });
        if (debit.count !== 1) throw fail(409, 'Insufficient available wallet funds');
        await tx.walletBalance.update({ where: { id: destinationBalance.id }, data: { availableMinor: { increment: input.amountMinor } } });
        const ledger = await tx.walletLedgerTransaction.create({ data: { idempotencyKey: `transfer:${input.idempotencyKey}`, entryType: WalletLedgerEntryType.TRANSFER, status: WalletLedgerStatus.POSTED, currency: input.currency, referenceType: 'WalletTransfer', metadataJson: inputJson({ senderId: user.id, recipientId: recipient.id }) } });
        const postings = [{ transactionId: ledger.id, accountId: sourceAccount.id, direction: WalletPostingDirection.CREDIT, amountMinor: input.amountMinor, currency: input.currency }, { transactionId: ledger.id, accountId: destinationAccount.id, direction: WalletPostingDirection.DEBIT, amountMinor: input.amountMinor, currency: input.currency }];
        assertBalancedPostings(postings.map(posting => ({ direction: posting.direction, amountMinor: posting.amountMinor, currency: posting.currency })));
        await tx.walletLedgerPosting.createMany({ data: postings });
        await appendWalletAllocations(tx, buildPostingAllocations(ledger.id, input.idempotencyKey, postings));
        const transfer = await tx.walletTransfer.create({ data: { senderId: user.id, recipientId: recipient.id, sourceAccountId: sourceAccount.id, destinationAccountId: destinationAccount.id, amountMinor: input.amountMinor, currency: input.currency, status: WalletTransferStatus.COMPLETED, idempotencyKey: input.idempotencyKey, ledgerTransactionId: ledger.id, completedAt: new Date() } });
        await auditInTransaction(tx, user.id, 'WALLET_TRANSFER_COMPLETED', 'WalletTransfer', transfer.id, { amountMinor: transfer.amountMinor, currency: transfer.currency });
        return transfer;
      });
      return res.status(201).json({ id: transfer.id, status: transfer.status, amountMinor: transfer.amountMinor, currency: transfer.currency });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await prisma.walletTransfer.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!raced) throw error;
      if (!transferMatches(raced, user.id, recipient.id, input)) throw fail(409, 'Idempotency key was already used for a different request');
      return res.status(200).json({ id: raced.id, status: raced.status });
    }
  }));

  app.post('/api/wallet/withdrawals', requireAuth, run(async (req, res) => {
    const input = withdrawalSchema.parse(req.body);
    const setting = await settings();
    if (!isWalletActionEnabled('walletWithdrawalsEnabled', walletGateSettings(setting), env.MONEY_MOVEMENT_HARD_DISABLED)) throw fail(409, 'Wallet withdrawals are disabled until an approved settlement workflow is configured');
    throw fail(503, 'Wallet withdrawal provider workflow is not configured');
  }));

  app.post('/api/wallet/checkout-authorize', requireAuth, run(async (_req, res) => {
    const setting = await settings();
    if (!isWalletActionEnabled('walletCheckoutEnabled', walletGateSettings(setting), env.MONEY_MOVEMENT_HARD_DISABLED)) throw fail(409, 'Wallet checkout is disabled');
    throw fail(503, 'Wallet checkout integration is pending order-lifecycle approval');
  }));

  app.get('/api/club-coins', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const [account, setting] = await Promise.all([userCoinAccount(user.id), settings()]);
    const entries = account ? await prisma.clubCoinEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 100 }) : [];
    res.json({ account: account ? { status: account.status, balance: account.balance } : { status: 'ACTIVE', balance: 0 }, entries, gates: walletSummary(setting) });
  }));

  app.get('/api/admin/wallet/summary', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [setting, accounts, balances, coins] = await Promise.all([
      settings(),
      prisma.walletAccount.count(),
      prisma.walletBalance.groupBy({ by: ['currency'], _sum: { availableMinor: true, pendingMinor: true, heldMinor: true, frozenMinor: true } }),
      prisma.clubCoinAccount.aggregate({ _sum: { balance: true }, _count: { _all: true } })
    ]);
    res.json({ gates: walletSummary(setting), walletAccounts: accounts, balances, clubCoins: coins });
  }));

  app.get('/api/admin/wallet/reconciliation', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const [balances, postings, allocations] = await Promise.all([
      prisma.walletBalance.findMany({ select: { accountId: true, currency: true, availableMinor: true, pendingMinor: true, heldMinor: true, frozenMinor: true, account: { select: { userId: true } } } }),
      prisma.walletLedgerPosting.findMany({ where: { transaction: { status: WalletLedgerStatus.POSTED } }, select: { accountId: true, currency: true, direction: true, amountMinor: true } }),
      prisma.walletBalanceAllocation.findMany({ select: { accountId: true, currency: true, state: true, deltaMinor: true, isOpeningBaseline: true, baselineVerified: true, transactionId: true } })
    ]);
    res.json(buildWalletReconciliationReport(balances.map(balance => ({ ...balance, userId: balance.account.userId })), postings, allocations));
  }));

  app.get('/api/admin/wallet/users', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const accounts = await prisma.walletAccount.findMany({ where: query ? { user: { OR: [{ email: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] } } : {}, include: { user: { select: { id: true, name: true, email: true } }, balances: true }, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json(accounts.map(account => ({ id: account.id, user: account.user, status: account.status, balances: account.balances })));
  }));

  app.patch('/api/admin/wallet/users/:userId/status', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const currentActor = actor(res);
    const input = z.object({ status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (param(req.params.userId) === currentActor.id && input.status !== 'ACTIVE') throw fail(400, 'An administrator cannot freeze or close their own wallet');
    const updated = await prisma.$transaction(async tx => {
      const account = await tx.walletAccount.findUnique({ where: { userId: param(req.params.userId) } });
      if (!account) return null;
      const next = await tx.walletAccount.update({ where: { id: account.id }, data: { status: input.status } });
      await auditInTransaction(tx, currentActor.id, 'WALLET_ACCOUNT_STATUS_CHANGED', 'WalletAccount', next.id, { status: input.status, reason: input.reason });
      return next;
    });
    if (!updated) return res.status(404).json({ error: 'Wallet account not found' });
    res.json({ id: updated.id, status: updated.status });
  }));

  app.patch('/api/admin/wallet/settings', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const currentActor = actor(res);
    const input = walletSettingsSchema.parse(req.body);
    const data = { ...input };
    delete (data as { reason?: string }).reason;
    const moneyKeys = ['walletEnabled', 'walletFundingEnabled', 'walletTransfersEnabled', 'walletCheckoutEnabled', 'walletWithdrawalsEnabled'] as const;
    if (moneyKeys.some(key => data[key] === true) && env.MONEY_MOVEMENT_HARD_DISABLED) throw fail(409, 'Real-money wallet movement is hard-disabled by server configuration');
    if ((data.clubCoinConversionEnabled || data.clubCoinTransfersEnabled) && env.CLUB_COINS_HARD_DISABLED) throw fail(409, 'Restricted Club Coins capabilities are hard-disabled by server configuration');
    const result = await prisma.$transaction(async tx => {
      const old = await tx.marketplaceSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
      const updated = await tx.marketplaceSettings.update({ where: { id: 'default' }, data });
      await auditInTransaction(tx, currentActor.id, 'WALLET_POLICY_CHANGED', 'MarketplaceSettings', 'default', { changed: Object.keys(data), reason: input.reason, moneyMovementHardDisabled: env.MONEY_MOVEMENT_HARD_DISABLED });
      return { old, updated };
    });
    res.json({ ...walletSummary(result.updated), previous: { walletEnabled: result.old.walletEnabled, clubCoinsEnabled: result.old.clubCoinsEnabled } });
  }));

  app.get('/api/admin/club-coins/rules', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await prisma.clubCoinRule.findMany({ orderBy: [{ enabled: 'desc' }, { eventType: 'asc' }, { code: 'asc' }] }))));

  app.post('/api/admin/club-coins/rules', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const currentActor = actor(res);
    const input = ruleSchema.parse(req.body);
    const rule = await prisma.$transaction(async tx => {
      const created = await tx.clubCoinRule.create({ data: { code: input.code, eventType: input.eventType, enabled: input.enabled, awardAmount: input.awardAmount, perUserCap: input.perUserCap, perOrderCap: input.perOrderCap, dailyCap: input.dailyCap, expiresAfterDays: input.expiresAfterDays, effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null, effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null, eligibleGroupsJson: inputJson(input.eligibleGroups ?? []), createdById: currentActor.id } });
      await auditInTransaction(tx, currentActor.id, 'CLUB_COINS_RULE_CREATED', 'ClubCoinRule', created.id, { code: created.code, eventType: created.eventType, awardAmount: created.awardAmount });
      return created;
    });
    res.status(201).json(rule);
  }));

  app.patch('/api/admin/club-coins/rules/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const currentActor = actor(res);
    const input = ruleSchema.partial().parse(req.body);
    const { effectiveFrom, effectiveTo, eligibleGroups, ...scalarInput } = input;
    const rule = await prisma.$transaction(async tx => {
      const updated = await tx.clubCoinRule.update({ where: { id: param(req.params.id) }, data: { ...scalarInput, ...(effectiveFrom !== undefined ? { effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null } : {}), ...(effectiveTo !== undefined ? { effectiveTo: effectiveTo ? new Date(effectiveTo) : null } : {}), ...(eligibleGroups !== undefined ? { eligibleGroupsJson: inputJson(eligibleGroups ?? []) } : {}) } });
      await auditInTransaction(tx, currentActor.id, 'CLUB_COINS_RULE_UPDATED', 'ClubCoinRule', updated.id, { changed: Object.keys(input) });
      return updated;
    });
    res.json(rule);
  }));

  app.post('/api/admin/club-coins/adjustments', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const currentActor = actor(res);
    const input = coinAdjustmentSchema.parse(req.body);
    const setting = await settings();
    if (env.CLUB_COINS_HARD_DISABLED || !setting.clubCoinsEnabled) throw fail(409, 'Club Coins are disabled');
    const result = await applyClubCoinAdjustment(currentActor.id, input);
    res.status(result.created ? 201 : 200).json(result.entry);
  }));

  app.post('/api/webhooks/stripe/wallet-funding', run(async (req, res) => {
    if (!walletFundingSandboxEnabled()) return res.status(503).json({ error: 'Sandbox wallet funding is disabled' });
    const provider = getStripeWalletFundingProvider();
    if (!provider) return res.status(503).json({ error: 'Stripe sandbox wallet funding provider is not configured' });
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) return res.status(400).json({ error: 'Raw Stripe webhook body is required' });
    let event;
    try {
      event = provider.verifyWebhook(rawBody, req.headers['stripe-signature'] as string | undefined);
    } catch {
      return res.status(400).json({ error: 'Invalid Stripe wallet webhook signature' });
    }
    try {
      const result = await processWalletFundingEvent(event);
      if (result.outcome === 'REJECTED') return res.status(422).json({ received: true, outcome: result.outcome, reason: result.reason });
      return res.json({ received: true, outcome: result.outcome });
    } catch (error) {
      if (error instanceof WalletFundingRetryableError) return res.status(503).json({ error: 'Wallet funding event requires retry or manual review' });
      throw error;
    }
  }));
}
