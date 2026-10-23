import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { IntegrationContext, IntegrationEnvironment, IntegrationProvider, PaymentMethod, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { prisma, requireAuth, requireRole } from './security.js';
import { livePaymentActivationBlock } from './provider-activation.js';
import { credentialKeysFor, evaluateProviderReadiness, redactProviderAuditReason, validateCredentialReferences, type CredentialReferences, type ProviderContext, type ProviderEnvironment, type ProviderName } from './provider-integrations-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, details?: unknown) => Object.assign(new Error(message), { statusCode, details });
const adminOnly = [Role.ADMIN];
const user = (res: Response) => res.locals.user as { id: string };
const reason = z.string().trim().min(3).max(500);
const providerName = z.nativeEnum(IntegrationProvider);
const providerContext = z.nativeEnum(IntegrationContext);
const providerEnvironment = z.nativeEnum(IntegrationEnvironment);
const credentialMap = z.record(z.string(), z.string());
const createSchema = z.object({ provider: providerName, context: providerContext, environment: providerEnvironment, name: z.string().trim().min(2).max(80), credentialReferences: credentialMap.default({}), reason }).strict();
const editSchema = z.object({ name: z.string().trim().min(2).max(80).optional(), credentialReferences: z.record(z.string(), z.union([z.string(), z.null()])).optional(), reason }).strict().refine(input => input.name !== undefined || input.credentialReferences !== undefined, 'Provide a name or credential-reference change.');
const enabledSchema = z.object({ enabled: z.boolean(), reason }).strict();
const archiveSchema = z.object({ reason }).strict();
const paymentMethodSchema = z.nativeEnum(PaymentMethod);
const paymentSwitchSchema = z.object({ enabled: z.boolean(), reason }).strict();

function currentRuntime() {
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID,
    PAYPAL_BASE_URL: env.PAYPAL_BASE_URL
  };
}

function readiness(config: { provider: string; context: string; environment: string; credentials: { credentialKey: string; reference: string }[] }) {
  const references = Object.fromEntries(config.credentials.map(item => [item.credentialKey, item.reference])) as CredentialReferences;
  return evaluateProviderReadiness({
    provider: config.provider as ProviderName,
    context: config.context as ProviderContext,
    environment: config.environment as ProviderEnvironment,
    references,
    runtime: currentRuntime(),
    liveConfigurationsAvailable: env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE,
    moneyMovementHardDisabled: env.MONEY_MOVEMENT_HARD_DISABLED
  });
}

function validatedReferences(provider: string, context: string, input: Record<string, unknown>) {
  try { return validateCredentialReferences(provider, context, input); }
  catch (error) { throw fail(400, error instanceof Error ? error.message : 'Invalid provider credential reference.'); }
}

function safeConfiguration(config: {
  id: string; provider: IntegrationProvider; context: IntegrationContext; environment: IntegrationEnvironment; name: string;
  enabled: boolean; archivedAt: Date | null; createdAt: Date; updatedAt: Date; lastCheckedAt: Date | null;
  credentials: { credentialKey: string; reference: string }[];
}) {
  const report = readiness(config);
  return {
    id: config.id, provider: config.provider, context: config.context, environment: config.environment, name: config.name,
    enabled: config.enabled, archivedAt: config.archivedAt, createdAt: config.createdAt, updatedAt: config.updatedAt,
    lastCheckedAt: config.lastCheckedAt, readiness: report,
    credentialReferences: report.credentials
  };
}

async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, entityId: string, metadata: unknown) {
  await tx.auditLog.create({ data: { actorId, action, entity: 'ProviderConfiguration', entityId, metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue } });
}

export function registerIntegrationRoutes(app: Express) {
  app.get('/api/admin/integrations', requireAuth, requireRole(...adminOnly), run(async (_req, res) => {
    const [configurations, methods] = await Promise.all([
      prisma.providerConfiguration.findMany({ where: { archivedAt: null }, include: { credentials: true }, orderBy: [{ context: 'asc' }, { provider: 'asc' }, { environment: 'asc' }, { createdAt: 'desc' }] }),
      prisma.paymentMethodSettings.findMany({ orderBy: { method: 'asc' } })
    ]);
    const enabledByMethod = new Map(methods.map(method => [method.method, method.enabled]));
    res.json({
      configurations: configurations.map(safeConfiguration),
      paymentMethods: Object.values(PaymentMethod).map(method => ({ method, enabled: enabledByMethod.get(method) ?? false })),
      liveConfigurationGate: env.LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE,
      notes: {
        secrets: 'The application stores references only. Secret values are read from the deployment environment; no provider connectivity check is performed.',
        checkout: 'The existing buyer payment-method switch remains authoritative for new sessions. Provider configuration records are inventory/readiness only; live-mode activation remains blocked until provider verification is implemented. Eligibility does not connect seller accounts.',
        wallet: env.MONEY_MOVEMENT_HARD_DISABLED ? 'Wallet funding is still blocked by the independent money-movement hard-disable.' : 'Wallet movement remains subject to its existing provider and marketplace gates.'
      }
    });
  }));

  app.post('/api/admin/integrations', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const actor = user(res);
    const input = createSchema.parse(req.body);
    const references = validatedReferences(input.provider, input.context, input.credentialReferences);
    const duplicate = await prisma.providerConfiguration.findFirst({ where: { provider: input.provider, context: input.context, environment: input.environment, archivedAt: null }, select: { id: true } });
    if (duplicate) throw fail(409, 'An active configuration already exists for this provider, context, and environment. Edit or archive it first.');
    try {
      const result = await prisma.$transaction(async tx => {
        const config = await tx.providerConfiguration.create({ data: {
          provider: input.provider, context: input.context, environment: input.environment, name: input.name,
          createdById: actor.id, updatedById: actor.id,
          credentials: { create: Object.entries(references).map(([credentialKey, reference]) => ({ credentialKey, reference })) }
        }, include: { credentials: true } });
        await audit(tx, actor.id, 'PROVIDER_CONFIGURATION_CREATED', config.id, { provider: input.provider, context: input.context, environment: input.environment, credentialFields: Object.keys(references), reason: redactProviderAuditReason(input.reason) });
        return config;
      });
      res.status(201).json(safeConfiguration(result));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'An active configuration already exists for this provider, context, and environment.');
      throw error;
    }
  }));

  app.patch('/api/admin/integrations/:id', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const actor = user(res);
    const id = param(req.params.id);
    const input = editSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProviderConfiguration" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await tx.providerConfiguration.findUnique({ where: { id }, include: { credentials: true } });
      if (!existing || existing.archivedAt) throw fail(404, 'Provider configuration not found.');
      if (input.credentialReferences && existing.enabled) throw fail(409, 'Disable the configuration before changing credential references.');
      const submittedReferences = input.credentialReferences ?? {};
      const allowedKeys = new Set<string>(credentialKeysFor(existing.provider, existing.context) ?? []);
      if (Object.keys(submittedReferences).some(key => !allowedKeys.has(key))) throw fail(400, 'Unsupported credential reference field.');
      const nonNullReferences = Object.fromEntries(Object.entries(submittedReferences).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const updates = validatedReferences(existing.provider, existing.context, nonNullReferences);
      const oldByKey = new Map(existing.credentials.map(item => [item.credentialKey, item.reference]));
      const changedKeys = (Object.keys(updates) as (keyof CredentialReferences)[]).filter(key => oldByKey.get(key) !== updates[key]);
      const removedKeys = Object.entries(submittedReferences).filter(([, value]) => value === null).map(([key]) => key);
      await tx.providerConfiguration.update({ where: { id }, data: { ...(input.name ? { name: input.name } : {}), updatedById: actor.id } });
      for (const [credentialKey, reference] of Object.entries(updates)) {
        await tx.providerCredentialReference.upsert({ where: { configurationId_credentialKey: { configurationId: id, credentialKey } }, create: { configurationId: id, credentialKey, reference: reference! }, update: { reference: reference! } });
      }
      if (removedKeys.length) await tx.providerCredentialReference.deleteMany({ where: { configurationId: id, credentialKey: { in: removedKeys } } });
      const fresh = await tx.providerConfiguration.findUniqueOrThrow({ where: { id }, include: { credentials: true } });
      await audit(tx, actor.id, 'PROVIDER_CONFIGURATION_UPDATED', id, { changedFields: [...(input.name ? ['name'] : []), ...(input.credentialReferences ? ['credentialReferences'] : [])], ...(input.name ? { oldName: existing.name, newName: input.name } : {}), changedCredentialKeys: changedKeys, removedCredentialKeys: removedKeys, reason: redactProviderAuditReason(input.reason) });
      return fresh;
    });
    res.json(safeConfiguration(result));
  }));

  app.patch('/api/admin/integrations/:id/enabled', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const actor = user(res);
    const id = param(req.params.id);
    const input = enabledSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProviderConfiguration" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await tx.providerConfiguration.findUnique({ where: { id }, include: { credentials: true } });
      if (!existing || existing.archivedAt) throw fail(404, 'Provider configuration not found.');
      const report = readiness(existing);
      if (input.enabled && !report.ready) throw fail(409, report.message, { code: report.code, readiness: report });
      const updated = await tx.providerConfiguration.update({ where: { id }, data: { enabled: input.enabled, updatedById: actor.id, lastCheckedAt: new Date() }, include: { credentials: true } });
      await audit(tx, actor.id, input.enabled ? 'PROVIDER_CONFIGURATION_ENABLED' : 'PROVIDER_CONFIGURATION_DISABLED', id, { provider: existing.provider, context: existing.context, environment: existing.environment, oldEnabled: existing.enabled, newEnabled: input.enabled, readinessCode: report.code, reason: redactProviderAuditReason(input.reason) });
      return updated;
    });
    res.json(safeConfiguration(result));
  }));

  app.post('/api/admin/integrations/:id/archive', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const actor = user(res);
    const id = param(req.params.id);
    const input = archiveSchema.parse(req.body);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ProviderConfiguration" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await tx.providerConfiguration.findUnique({ where: { id }, include: { credentials: true } });
      if (!existing || existing.archivedAt) throw fail(404, 'Provider configuration not found.');
      const updated = await tx.providerConfiguration.update({ where: { id }, data: { enabled: false, archivedAt: new Date(), updatedById: actor.id }, include: { credentials: true } });
      await audit(tx, actor.id, 'PROVIDER_CONFIGURATION_ARCHIVED', id, { provider: existing.provider, context: existing.context, environment: existing.environment, oldEnabled: existing.enabled, newEnabled: false, oldArchivedAt: null, newArchivedAt: updated.archivedAt, reason: redactProviderAuditReason(input.reason) });
      return updated;
    });
    res.json(safeConfiguration(result));
  }));

  app.patch('/api/admin/integrations/payment-methods/:method', requireAuth, requireRole(...adminOnly), run(async (req, res) => {
    const actor = user(res);
    const method = paymentMethodSchema.parse(param(req.params.method));
    const input = paymentSwitchSchema.parse(req.body);
    if (input.enabled) {
      const block = await livePaymentActivationBlock(method);
      if (block) throw fail(409, block.error);
    }
    const result = await prisma.$transaction(async tx => {
      const before = await tx.paymentMethodSettings.findUnique({ where: { method } });
      const updated = await tx.paymentMethodSettings.upsert({ where: { method }, create: { id: method.toLowerCase(), method, enabled: input.enabled }, update: { enabled: input.enabled } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'PAYMENT_METHOD_CHANGED', entity: 'PaymentMethodSettings', entityId: method, metadata: { old: before?.enabled ?? false, new: input.enabled, reason: redactProviderAuditReason(input.reason) } } });
      return updated;
    });
    res.json({ method: result.method, enabled: result.enabled, updatedAt: result.updatedAt });
  }));
}
