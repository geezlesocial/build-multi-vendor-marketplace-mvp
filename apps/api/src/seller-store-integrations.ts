import crypto from 'node:crypto';
import { lookup, resolveCname, resolveTxt } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Role, SellerStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { effectiveStorePlan, storeEntitlements } from './store-plan-domain.js';
import { isFreePlan } from './store-plan-pricing.js';
import { emailProviders, type EffectiveEmailSettings } from './store-email-provider-config.js';
import { redactProviderAuditReason } from './provider-integrations-domain.js';
import { customDomainDnsReady, isPublicSmtpAddress, normalizeCustomDomain, normalizeDnsHostname, storeIntegrationEligible, tokenDigest } from './seller-integrations-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
const verifyTtlMs = 24 * 60 * 60_000;
const providerIds = new Set<string>(emailProviders.map(provider => provider.id));

function encryptionKey(storeId: string) {
  return crypto.createHash('sha256').update(`${env.PASSWORD_PEPPER}:store-email-provider:${storeId}`).digest();
}
function encrypt(storeId: string, value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(storeId), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}
function decrypt(storeId: string, value: string | null) {
  if (!value) return null;
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Saved credential format is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(storeId), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}
function safeCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code).toUpperCase() : '';
  return code === 'EAUTH' || code === 'AUTH' ? 'EMAIL_AUTH_FAILED' : 'EMAIL_CONNECTION_FAILED';
}

async function sellerScope(res: Response) {
  const user = actor(res);
  if (!user.sellerId) throw fail(403, 'Approved seller scope is required.');
  const seller = await prisma.seller.findFirst({ where: { id: user.sellerId, status: SellerStatus.APPROVED }, select: { id: true, store: { select: { id: true, name: true, slug: true, isPlatformStore: true } } } });
  if (!seller?.store) throw fail(403, 'An approved seller Store is required.');
  const effective = await effectiveStorePlan(prisma, seller.store.id);
  const entitlements = await storeEntitlements(prisma, seller.store.id, effective.version);
  const paid = Boolean(effective.version && !isFreePlan(effective.version));
  const platformAdminOverride = user.role === Role.ADMIN && seller.store.isPlatformStore;
  return {
    user, store: seller.store, effective, platformAdminOverride,
    domainEligible: storeIntegrationEligible({ isOfficialAdminStore: platformAdminOverride, paidPlan: paid, entitlementEnabled: entitlements.customDomainEligible }),
    smtpEligible: storeIntegrationEligible({ isOfficialAdminStore: platformAdminOverride, paidPlan: paid, entitlementEnabled: entitlements.emailMarketingEnabled })
  };
}

function marketplaceHosts() {
  return [env.WEB_ORIGIN, env.SITE_URL].flatMap(value => { try { return [new URL(value).hostname]; } catch { return []; } });
}
function configuredDomainTarget() {
  if (!env.CUSTOM_DOMAIN_TARGET) return null;
  try { return normalizeDnsHostname(env.CUSTOM_DOMAIN_TARGET); } catch { return null; }
}

async function verifyDns(domain: string, tokenHash: string, cnameTarget: string) {
  const recordName = `_marketlane-verification.${domain}`;
  const [txtResult, cnameResult] = await Promise.allSettled([resolveTxt(recordName), resolveCname(domain)]);
  const txtValues = txtResult.status === 'fulfilled' ? txtResult.value.flat().map(value => value.trim()) : [];
  const cnameValues = cnameResult.status === 'fulfilled' ? cnameResult.value.map(value => value.replace(/\.$/, '').toLowerCase()) : [];
  const ownershipTokenMatches = txtValues.some(value => tokenDigest(value) === tokenHash);
  const cnameMatches = cnameValues.includes(cnameTarget.toLowerCase());
  return { ownershipTokenMatches, cnameMatches, ready: customDomainDnsReady({ ownershipTokenMatches, cnameMatches }) };
}

const smtpInputSchema = z.object({
  host: z.string().trim().min(1).max(253).refine(value => { try { normalizeDnsHostname(value); return true; } catch { return false; } }, 'Enter a public SMTP hostname, not a URL or IP address.'),
  port: z.number().int().min(1).max(65535), secure: z.boolean(), requireTls: z.boolean(),
  username: z.string().trim().max(255).default(''), password: z.string().max(2000).default(''),
  senderName: z.string().trim().min(1).max(120), senderEmail: z.string().trim().email().max(320),
  replyTo: z.union([z.string().trim().email().max(320), z.literal('')]).default(''),
  reason: z.string().trim().min(5).max(500)
}).strict().refine(value => value.secure || value.requireTls, { message: 'Use implicit TLS or require STARTTLS.', path: ['requireTls'] });

async function readSellerEmailConfiguration(storeId: string) {
  const row = await prisma.storeEmailProviderConfiguration.findUnique({ where: { storeId } });
  if (!row) return null;
  let credentialUnreadable = false;
  try { decrypt(storeId, row.passwordCiphertext); } catch { credentialUnreadable = true; }
  return { row, credentialUnreadable };
}

/** Returns a seller-owned configuration only when explicitly active and recently verified. */
export async function resolveSellerStoreEmailSettings(storeId: string): Promise<EffectiveEmailSettings | null> {
  const plan = await effectiveStorePlan(prisma, storeId);
  const entitlements = await storeEntitlements(prisma, storeId, plan.version);
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { isPlatformStore: true } });
  if (!store || !storeIntegrationEligible({
    isOfficialAdminStore: store.isPlatformStore,
    paidPlan: Boolean(plan.version && !isFreePlan(plan.version)),
    entitlementEnabled: entitlements.emailMarketingEnabled
  })) return null;
  const row = await prisma.storeEmailProviderConfiguration.findUnique({ where: { storeId } });
  if (!row?.active || !row.verifiedAt || Date.now() - row.verifiedAt.getTime() >= verifyTtlMs) return null;
  let password: string | null;
  try { password = decrypt(storeId, row.passwordCiphertext); } catch { return null; }
  return {
    provider: row.provider,
    providerLabel: emailProviders.find(provider => provider.id === row.provider)?.label ?? row.provider,
    host: row.host, port: row.port, secure: row.secure, requireTls: row.requireTls,
    username: row.username ?? undefined, password: password ?? undefined,
    senderName: row.senderName, senderEmail: row.senderEmail, replyTo: row.replyTo ?? undefined,
    verifiedAt: row.verifiedAt, configurationUpdatedAt: row.updatedAt, source: 'SELLER_STORE'
  };
}

/** Pin seller SMTP connections to a vetted public IP to avoid private-network SSRF and DNS rebinding. */
export async function createSellerSmtpTransport(settings: EffectiveEmailSettings) {
  const addresses = await lookup(settings.host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicSmtpAddress(item.address))) throw fail(400, 'The SMTP hostname must resolve only to public Internet addresses.');
  return nodemailer.createTransport({
    host: addresses[0]!.address, port: settings.port, secure: settings.secure, requireTLS: settings.requireTls,
    tls: { servername: settings.host },
    ...(settings.username && settings.password ? { auth: { user: settings.username, pass: settings.password } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1
  });
}

export async function sellerStoreEmailStatus(storeId: string) {
  const settings = await resolveSellerStoreEmailSettings(storeId);
  return { active: Boolean(settings), provider: settings?.provider ?? null, providerLabel: settings?.providerLabel ?? null };
}

export function registerSellerStoreIntegrationRoutes(app: Express) {
  app.get('/api/seller/integrations', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const scope = await sellerScope(res);
    const [domain, email] = await Promise.all([
      prisma.storeCustomDomain.findUnique({ where: { storeId: scope.store.id } }),
      readSellerEmailConfiguration(scope.store.id)
    ]);
    const target = configuredDomainTarget();
    const providers = emailProviders.map(provider => ({ ...provider }));
    const selected = email?.row;
    res.json({
      store: { id: scope.store.id, name: scope.store.name },
      platformAdminOverride: scope.platformAdminOverride,
      customDomain: { eligible: scope.domainEligible, targetConfigured: Boolean(target), target, domain: domain ? { domain: domain.domain, status: domain.status, verifiedAt: domain.verifiedAt?.toISOString() ?? null, cnameTarget: domain.cnameTarget, lastCheckedAt: domain.lastCheckedAt?.toISOString() ?? null } : null },
      email: { eligible: scope.smtpEligible, active: Boolean(selected?.active && selected.verifiedAt && Date.now() - selected.verifiedAt.getTime() < verifyTtlMs), provider: selected?.provider ?? null, host: selected?.host ?? null, port: selected?.port ?? null, secure: selected?.secure ?? null, requireTls: selected?.requireTls ?? null, usernameConfigured: Boolean(selected?.username), passwordConfigured: Boolean(selected?.passwordCiphertext), credentialUnreadable: email?.credentialUnreadable ?? false, senderName: selected?.senderName ?? '', senderEmail: selected?.senderEmail ?? '', replyTo: selected?.replyTo ?? '', verifiedAt: selected?.verifiedAt?.toISOString() ?? null, lastTestAt: selected?.lastTestAt?.toISOString() ?? null, lastTestCode: selected?.lastTestCode ?? null },
      providers,
      notes: { customDomain: 'DNS ownership and CNAME are verified by this application. Your hosting provider must also route the hostname to the marketplace and provision HTTPS/TLS; those steps are not automated by this deployment.', email: 'Seller SMTP is used only for this Store’s consent-based newsletter confirmations and campaigns. Marketplace account, order, and security emails continue using platform SMTP.' }
    });
  }));

  app.put('/api/seller/custom-domain', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const scope = await sellerScope(res);
    if (!scope.domainEligible) throw fail(403, 'Custom domains require an eligible paid Store Plan.', 'PLAN_FEATURE_NOT_ENABLED');
    const target = configuredDomainTarget();
    if (!target) throw fail(503, 'Custom domains are not configured by the marketplace hosting administrator yet.', 'CUSTOM_DOMAIN_HOSTING_NOT_CONFIGURED');
    const input = z.object({ domain: z.string().trim().min(3).max(253) }).strict().parse(req.body);
    const domain = normalizeCustomDomain(input.domain, marketplaceHosts());
    if (await prisma.storeCustomDomain.findFirst({ where: { domain, storeId: { not: scope.store.id } }, select: { id: true } })) throw fail(409, 'That domain is already connected to another Store.');
    const token = crypto.randomBytes(32).toString('base64url');
    const current = await prisma.storeCustomDomain.findUnique({ where: { storeId: scope.store.id } });
    const saved = current
      ? await prisma.storeCustomDomain.update({ where: { storeId: scope.store.id }, data: { domain, cnameTarget: target, verificationTokenHash: tokenDigest(token), status: 'PENDING_DNS', verifiedAt: null, lastCheckedAt: null } })
      : await prisma.storeCustomDomain.create({ data: { storeId: scope.store.id, domain, cnameTarget: target, verificationTokenHash: tokenDigest(token) } });
    await audit(scope.user.id, 'SELLER_CUSTOM_DOMAIN_SAVED', 'StoreCustomDomain', saved.id, { storeId: scope.store.id, domain, target });
    res.status(201).json({ domain: saved.domain, status: saved.status, records: [{ type: 'TXT', host: `_marketlane-verification.${domain}`, value: token }, { type: 'CNAME', host: domain, value: target }], message: 'Add both DNS records, then run Verify DNS. DNS verification does not provision HTTPS; complete the hosting-provider steps shown below before using this as your live website.' });
  }));

  app.post('/api/seller/custom-domain/rotate-verification', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const scope = await sellerScope(res);
    if (!scope.domainEligible) throw fail(403, 'Custom domains require an eligible paid Store Plan.', 'PLAN_FEATURE_NOT_ENABLED');
    const current = await prisma.storeCustomDomain.findUnique({ where: { storeId: scope.store.id } });
    if (!current) throw fail(404, 'Add a domain before requesting DNS verification records.');
    const token = crypto.randomBytes(32).toString('base64url');
    const saved = await prisma.storeCustomDomain.update({ where: { storeId: scope.store.id }, data: { verificationTokenHash: tokenDigest(token), status: 'PENDING_DNS', verifiedAt: null, lastCheckedAt: null } });
    res.json({ domain: saved.domain, status: saved.status, records: [{ type: 'TXT', host: `_marketlane-verification.${saved.domain}`, value: token }, { type: 'CNAME', host: saved.domain, value: saved.cnameTarget }] });
  }));

  app.post('/api/seller/custom-domain/verify', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const scope = await sellerScope(res);
    if (!scope.domainEligible) throw fail(403, 'Custom domains require an eligible paid Store Plan.', 'PLAN_FEATURE_NOT_ENABLED');
    const domain = await prisma.storeCustomDomain.findUnique({ where: { storeId: scope.store.id } });
    if (!domain) throw fail(404, 'Add a domain before verifying DNS.');
    const check = await verifyDns(domain.domain, domain.verificationTokenHash, domain.cnameTarget);
    const checkedAt = new Date();
    const updated = await prisma.storeCustomDomain.update({ where: { id: domain.id }, data: { status: check.ready ? 'DNS_VERIFIED' : 'PENDING_DNS', verifiedAt: check.ready ? checkedAt : null, lastCheckedAt: checkedAt } });
    await audit(scope.user.id, check.ready ? 'SELLER_CUSTOM_DOMAIN_DNS_VERIFIED' : 'SELLER_CUSTOM_DOMAIN_DNS_CHECKED', 'StoreCustomDomain', domain.id, { storeId: scope.store.id, domain: domain.domain, ownershipTokenMatches: check.ownershipTokenMatches, cnameMatches: check.cnameMatches });
    res.json({ domain: updated.domain, status: updated.status, checkedAt: checkedAt.toISOString(), checks: check, message: check.ready ? 'Ownership and CNAME records are verified. Next, add this hostname in your hosting provider and wait for its HTTPS/TLS certificate before sharing the domain.' : 'DNS records are not both visible yet. Wait for DNS propagation, then check again.' });
  }));

  app.delete('/api/seller/custom-domain', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const scope = await sellerScope(res);
    const deleted = await prisma.storeCustomDomain.deleteMany({ where: { storeId: scope.store.id } });
    if (!deleted.count) throw fail(404, 'No custom domain is connected to this Store.');
    await audit(scope.user.id, 'SELLER_CUSTOM_DOMAIN_REMOVED', 'StoreCustomDomain', scope.store.id, { storeId: scope.store.id });
    res.status(204).send();
  }));

  app.get('/api/public/store-domain', run(async (req, res) => {
    let host: string;
    try { host = normalizeCustomDomain(req.hostname, marketplaceHosts()); }
    catch { return res.status(404).json({ error: 'No Store is connected to this hostname.' }); }
    const domain = await prisma.storeCustomDomain.findUnique({ where: { domain: host }, include: { store: { include: { seller: { select: { status: true } } } } } });
    if (!domain || domain.status !== 'DNS_VERIFIED' || domain.store.seller.status !== SellerStatus.APPROVED) return res.status(404).json({ error: 'No active Store is connected to this hostname.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ storeSlug: domain.store.slug, storeName: domain.store.name });
  }));

  app.put('/api/seller/email/providers/:provider', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const scope = await sellerScope(res);
    if (!scope.smtpEligible) throw fail(403, 'Seller SMTP requires a paid Store Plan with email marketing enabled.', 'PLAN_FEATURE_NOT_ENABLED');
    const provider = param(req.params.provider).toUpperCase();
    if (!providerIds.has(provider)) throw fail(404, 'Unsupported email provider.');
    const input = smtpInputSchema.parse(req.body);
    const current = await prisma.storeEmailProviderConfiguration.findUnique({ where: { storeId: scope.store.id } });
    const sameProvider = current?.provider === provider;
    const username = input.username || (sameProvider ? current?.username ?? '' : '');
    let previousPassword = '';
    if (sameProvider && current?.passwordCiphertext) {
      try { previousPassword = decrypt(scope.store.id, current.passwordCiphertext) ?? ''; }
      catch { if (!input.password) throw fail(409, 'Saved SMTP credential cannot be decrypted. Enter a replacement credential and save again.'); }
    }
    const password = input.password || previousPassword;
    if (Boolean(username) !== Boolean(password)) throw fail(400, 'SMTP username and password/API credential must be provided together.');
    const saved = await prisma.storeEmailProviderConfiguration.upsert({
      where: { storeId: scope.store.id },
      create: { storeId: scope.store.id, provider, host: normalizeDnsHostname(input.host), port: input.port, secure: input.secure, requireTls: input.requireTls, username: username || null, passwordCiphertext: password ? encrypt(scope.store.id, password) : null, senderName: input.senderName, senderEmail: input.senderEmail, replyTo: input.replyTo || null, updatedById: scope.user.id },
      update: { provider, host: normalizeDnsHostname(input.host), port: input.port, secure: input.secure, requireTls: input.requireTls, username: username || null, passwordCiphertext: password ? encrypt(scope.store.id, password) : null, senderName: input.senderName, senderEmail: input.senderEmail, replyTo: input.replyTo || null, active: false, verifiedAt: null, lastTestAt: null, lastTestCode: null, updatedById: scope.user.id }
    });
    await audit(scope.user.id, 'SELLER_EMAIL_PROVIDER_SAVED', 'StoreEmailProviderConfiguration', scope.store.id, { storeId: scope.store.id, provider, host: saved.host, port: saved.port, secure: saved.secure, requireTls: saved.requireTls, reason: redactProviderAuditReason(input.reason), credentialsConfigured: Boolean(username && password) });
    res.json({ saved: true, active: false, message: 'SMTP settings saved. Test this connection, then activate it. Credentials are encrypted and never returned.' });
  }));

  app.post('/api/seller/email/providers/:provider/test', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const scope = await sellerScope(res);
    if (!scope.smtpEligible) throw fail(403, 'Seller SMTP requires a paid Store Plan with email marketing enabled.', 'PLAN_FEATURE_NOT_ENABLED');
    const provider = param(req.params.provider).toUpperCase();
    const reason = z.object({ reason: z.string().trim().min(5).max(500) }).strict().parse(req.body).reason;
    const row = await prisma.storeEmailProviderConfiguration.findUnique({ where: { storeId: scope.store.id } });
    if (!row || row.provider !== provider) throw fail(409, 'Save this provider before testing it.');
    let password: string | null;
    try { password = decrypt(scope.store.id, row.passwordCiphertext); }
    catch { throw fail(409, 'Saved SMTP credential cannot be decrypted. Enter a replacement credential and save again.'); }
    const settings: EffectiveEmailSettings = { provider: row.provider, providerLabel: emailProviders.find(item => item.id === provider)?.label ?? provider, host: row.host, port: row.port, secure: row.secure, requireTls: row.requireTls, username: row.username ?? undefined, password: password ?? undefined, senderName: row.senderName, senderEmail: row.senderEmail, replyTo: row.replyTo ?? undefined, source: 'SELLER_STORE' };
    const testedAt = new Date();
    try {
      const transport = await createSellerSmtpTransport(settings);
      try { await transport.verify(); } finally { transport.close(); }
      const updated = await prisma.storeEmailProviderConfiguration.updateMany({ where: { storeId: scope.store.id, updatedAt: row.updatedAt }, data: { verifiedAt: testedAt, lastTestAt: testedAt, lastTestCode: null } });
      if (updated.count !== 1) throw fail(409, 'SMTP settings changed during the test. Run the test again.');
      await audit(scope.user.id, 'SELLER_EMAIL_PROVIDER_TESTED', 'StoreEmailProviderConfiguration', scope.store.id, { storeId: scope.store.id, provider, testedAt: testedAt.toISOString(), reason: redactProviderAuditReason(reason) });
      res.json({ verified: true, testedAt: testedAt.toISOString(), message: 'SMTP connection verified. No email was sent.' });
    } catch (error) {
      const code = safeCode(error);
      await prisma.storeEmailProviderConfiguration.updateMany({ where: { storeId: scope.store.id, updatedAt: row.updatedAt }, data: { verifiedAt: null, lastTestAt: testedAt, lastTestCode: code, active: false } });
      await audit(scope.user.id, 'SELLER_EMAIL_PROVIDER_TEST_FAILED', 'StoreEmailProviderConfiguration', scope.store.id, { storeId: scope.store.id, provider, code, reason: redactProviderAuditReason(reason) });
      if (error && typeof error === 'object' && 'statusCode' in error) throw error;
      throw fail(502, code === 'EMAIL_AUTH_FAILED' ? 'The email provider rejected these credentials.' : 'The SMTP connection failed. Check the host, port, TLS mode, credentials, and provider network policy.', code);
    }
  }));

  app.patch('/api/seller/email/providers/:provider/activation', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const scope = await sellerScope(res);
    if (!scope.smtpEligible) throw fail(403, 'Seller SMTP requires a paid Store Plan with email marketing enabled.', 'PLAN_FEATURE_NOT_ENABLED');
    const provider = param(req.params.provider).toUpperCase();
    const input = z.object({ active: z.boolean(), reason: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    const row = await prisma.storeEmailProviderConfiguration.findUnique({ where: { storeId: scope.store.id } });
    if (!row || row.provider !== provider) throw fail(404, 'SMTP configuration not found.');
    if (input.active && (!row.verifiedAt || Date.now() - row.verifiedAt.getTime() >= verifyTtlMs)) throw fail(409, 'Test the saved SMTP settings successfully within the last 24 hours before activating.');
    await prisma.storeEmailProviderConfiguration.update({ where: { storeId: scope.store.id }, data: { active: input.active, ...(!input.active ? { verifiedAt: null } : {}) } });
    await audit(scope.user.id, input.active ? 'SELLER_EMAIL_PROVIDER_ACTIVATED' : 'SELLER_EMAIL_PROVIDER_DEACTIVATED', 'StoreEmailProviderConfiguration', scope.store.id, { storeId: scope.store.id, provider, reason: redactProviderAuditReason(input.reason), active: input.active });
    res.json({ active: input.active, message: input.active ? 'This SMTP provider is active for this Store’s consent-based email campaigns.' : 'Seller SMTP is inactive. Platform email settings remain unchanged.' });
  }));
}
