import crypto from 'node:crypto';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { Role } from '@prisma/client';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const verificationTtlMs = 24 * 60 * 60_000;

export const emailProviders = [
  { id: 'MAILTRAP', label: 'Mailtrap', host: 'sandbox.smtp.mailtrap.io', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'BREVO', label: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'GMAIL', label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'SENDGRID', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false, requireTls: true, username: 'apikey' },
  { id: 'MAILGUN', label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'AMAZON_SES', label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'POSTMARK', label: 'Postmark', host: 'smtp.postmarkapp.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'SMTP2GO', label: 'SMTP2GO', host: 'mail.smtp2go.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'MAILJET', label: 'Mailjet', host: 'in-v3.mailjet.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'MAILERSEND', label: 'MailerSend', host: 'smtp.mailersend.net', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'ZOHO', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 587, secure: false, requireTls: true, username: '' },
  { id: 'NAMECHEAP', label: 'Namecheap Private Email', host: 'mail.privateemail.com', port: 465, secure: true, requireTls: false, username: '' },
  { id: 'MANUAL_SMTP', label: 'Manual SMTP', host: '', port: 587, secure: false, requireTls: true, username: '' }
] as const;

export type MailProviderId = typeof emailProviders[number]['id'];
export type EffectiveEmailSettings = {
  provider: string;
  providerLabel: string;
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  username?: string;
  password?: string;
  senderName: string;
  senderEmail: string;
  replyTo?: string;
  verifiedAt?: Date | null;
  configurationUpdatedAt?: Date;
  source: 'ADMIN_DASHBOARD' | 'SELLER_STORE' | 'DEPLOYMENT_ENVIRONMENT' | 'NOT_CONFIGURED';
  credentialError?: boolean;
};

const providerSet = new Set<string>(emailProviders.map(item => item.id));
function encryptionKey() {
  return crypto.createHash('sha256').update(`${env.PASSWORD_PEPPER}:admin-email-provider-config`).digest();
}
function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}
function decrypt(value: string | null) {
  if (!value) return null;
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Stored email credential format is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}
function safelyDecrypt(value: string | null) {
  try { return { password: decrypt(value), credentialError: false }; }
  catch { return { password: undefined, credentialError: true }; }
}

const configInput = z.object({
  host: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9.-]+$/, 'Enter a hostname only, without a protocol or path.').refine(value => !isIP(value) && !/(^|\.)(localhost|local|internal|lan)$/i.test(value), 'Use a public DNS hostname, not a local hostname or IP address.'),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  requireTls: z.boolean(),
  username: z.string().trim().max(255).optional().default(''),
  password: z.string().max(2000).optional().default(''),
  senderName: z.string().trim().min(1).max(120),
  senderEmail: z.string().trim().email().max(320),
  replyTo: z.union([z.string().trim().email().max(320), z.literal('')]).optional().default(''),
  reason: z.string().trim().min(3).max(500)
}).strict().refine(value => value.secure || value.requireTls, { message: 'Use implicit TLS or require STARTTLS.', path: ['requireTls'] });

function safeProviderError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code).toUpperCase() : '';
  return code === 'EAUTH' || code === 'AUTH' ? 'EMAIL_AUTH_FAILED' : 'EMAIL_CONNECTION_FAILED';
}
function transportOptions(settings: EffectiveEmailSettings) {
  return {
    host: settings.host, port: settings.port, secure: settings.secure, requireTLS: settings.requireTls,
    ...(settings.username && settings.password ? { auth: { user: settings.username, pass: settings.password } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1
  };
}

export async function resolvePlatformEmailSettings(): Promise<EffectiveEmailSettings> {
  const selection = await prisma.platformEmailProviderSelection.findUnique({ where: { id: 'default' }, include: { configuration: true } });
  const active = selection?.configuration;
  if (active) {
    const credential = safelyDecrypt(active.passwordCiphertext);
    return {
      provider: active.provider,
      providerLabel: emailProviders.find(item => item.id === active.provider)?.label ?? active.provider,
      host: active.host, port: active.port, secure: active.secure, requireTls: active.requireTls,
      username: active.username ?? undefined, password: credential.password ?? undefined,
      senderName: active.senderName, senderEmail: active.senderEmail, replyTo: active.replyTo ?? undefined,
      verifiedAt: active.verifiedAt, configurationUpdatedAt: active.updatedAt, source: 'ADMIN_DASHBOARD', credentialError: credential.credentialError
    };
  }
  if (env.STORE_EMAIL_SMTP_HOST && env.STORE_EMAIL_FROM) {
    return {
      provider: 'DEPLOYMENT_ENVIRONMENT', providerLabel: 'Deployment environment',
      host: env.STORE_EMAIL_SMTP_HOST, port: env.STORE_EMAIL_SMTP_PORT,
      secure: env.STORE_EMAIL_SMTP_SECURE, requireTls: env.STORE_EMAIL_SMTP_REQUIRE_TLS,
      username: env.STORE_EMAIL_SMTP_USER, password: env.STORE_EMAIL_SMTP_PASSWORD,
      senderName: 'Market Lane', senderEmail: env.STORE_EMAIL_FROM, replyTo: env.STORE_EMAIL_REPLY_TO,
      source: 'DEPLOYMENT_ENVIRONMENT'
    };
  }
  return { provider: '', providerLabel: '', host: '', port: env.STORE_EMAIL_SMTP_PORT, secure: false, requireTls: true, senderName: '', senderEmail: '', source: 'NOT_CONFIGURED' };
}

export async function listEmailProviderConfigurations() {
  const [rows, selection] = await Promise.all([
    prisma.emailProviderConfiguration.findMany(),
    prisma.platformEmailProviderSelection.findUnique({ where: { id: 'default' } })
  ]);
  const byProvider = new Map(rows.map(row => [row.provider, row]));
  return {
    activeProvider: selection?.provider ?? null,
    deploymentFallbackConfigured: Boolean(env.STORE_EMAIL_SMTP_HOST && env.STORE_EMAIL_FROM),
    providers: emailProviders.map(definition => {
      const row = byProvider.get(definition.id);
      return {
        ...definition,
        host: row?.host ?? definition.host,
        port: row?.port ?? definition.port,
        secure: row?.secure ?? definition.secure,
        requireTls: row?.requireTls ?? definition.requireTls,
        senderName: row?.senderName ?? 'Market Lane',
        senderEmail: row?.senderEmail ?? env.STORE_EMAIL_FROM ?? '',
        replyTo: row?.replyTo ?? '',
        usernameConfigured: Boolean(row?.username),
        passwordConfigured: Boolean(row?.passwordCiphertext),
        credentialUnreadable: row ? safelyDecrypt(row.passwordCiphertext).credentialError : false,
        saved: Boolean(row),
        active: selection?.provider === definition.id,
        verifiedAt: row?.verifiedAt?.toISOString() ?? null,
        lastTestAt: row?.lastTestAt?.toISOString() ?? null,
        lastTestCode: row?.lastTestCode ?? null
      };
    })
  };
}

export async function verifyStoredEmailProvider(provider: string) {
  if (!providerSet.has(provider)) throw Object.assign(new Error('Unsupported email provider.'), { statusCode: 404 });
  const row = await prisma.emailProviderConfiguration.findUnique({ where: { provider } });
  if (!row) throw Object.assign(new Error('Save this provider configuration before testing it.'), { statusCode: 409 });
  const credential = safelyDecrypt(row.passwordCiphertext);
  if (credential.credentialError) throw Object.assign(new Error('The saved credential cannot be decrypted. Re-enter the SMTP password/API credential, save, and test again.'), { statusCode: 409 });
  const settings: EffectiveEmailSettings = {
    provider, providerLabel: emailProviders.find(item => item.id === provider)!.label,
    host: row.host, port: row.port, secure: row.secure, requireTls: row.requireTls,
    username: row.username ?? undefined, password: credential.password ?? undefined,
    senderName: row.senderName, senderEmail: row.senderEmail, replyTo: row.replyTo ?? undefined, source: 'ADMIN_DASHBOARD'
  };
  const transport = nodemailer.createTransport(transportOptions(settings));
  const testedAt = new Date();
  try {
    try { await transport.verify(); }
    catch (error) {
      const code = safeProviderError(error);
      await prisma.emailProviderConfiguration.updateMany({ where: { provider, updatedAt: row.updatedAt }, data: { verifiedAt: null, lastTestAt: testedAt, lastTestCode: code } });
      throw Object.assign(new Error(code === 'EMAIL_AUTH_FAILED' ? 'The provider rejected these credentials. Check the SMTP username and password/API credential.' : 'The provider connection failed. Check the host, port, TLS mode, and network access.'), { statusCode: 502, code });
    }
    const update = await prisma.emailProviderConfiguration.updateMany({ where: { provider, updatedAt: row.updatedAt }, data: { verifiedAt: testedAt, lastTestAt: testedAt, lastTestCode: null } });
    if (update.count !== 1) throw Object.assign(new Error('Provider settings changed during the test. Run the connection test again.'), { statusCode: 409 });
    return { verified: true as const, testedAt: testedAt.toISOString(), message: `${settings.providerLabel} SMTP connection verified. No email was sent.` };
  } finally { transport.close(); }
}

export async function verifyActiveEmailProvider() {
  const settings = await resolvePlatformEmailSettings();
  if (!settings.host || !settings.senderEmail) throw Object.assign(new Error('Configure and save an email provider before verification.'), { statusCode: 409 });
  const transport = nodemailer.createTransport(transportOptions(settings));
  try {
    await transport.verify();
    if (settings.source === 'ADMIN_DASHBOARD') {
      const verifiedAt = new Date();
      const updated = await prisma.emailProviderConfiguration.updateMany({ where: { provider: settings.provider, updatedAt: settings.configurationUpdatedAt }, data: { verifiedAt, lastTestAt: verifiedAt, lastTestCode: null } });
      if (updated.count !== 1) throw Object.assign(new Error('Provider settings changed during verification. Test the saved configuration again.'), { statusCode: 409 });
    }
    return { verified: true as const, message: `${settings.providerLabel} SMTP connection verified. No email was sent.` };
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409) throw error;
    const code = safeProviderError(error);
    if (settings.source === 'ADMIN_DASHBOARD') await prisma.emailProviderConfiguration.updateMany({ where: { provider: settings.provider, updatedAt: settings.configurationUpdatedAt }, data: { verifiedAt: null, lastTestAt: new Date(), lastTestCode: code } });
    throw Object.assign(new Error(code === 'EMAIL_AUTH_FAILED' ? 'The provider rejected these credentials.' : 'The email provider connection could not be completed.'), { statusCode: 502, code });
  } finally { transport.close(); }
}

export function emailSettingsVerified(settings: EffectiveEmailSettings, environmentVerified: boolean) {
  if (settings.source === 'ADMIN_DASHBOARD') return Boolean(settings.verifiedAt && Date.now() - settings.verifiedAt.getTime() < verificationTtlMs);
  if (settings.source === 'SELLER_STORE') return Boolean(settings.verifiedAt && Date.now() - settings.verifiedAt.getTime() < verificationTtlMs);
  return environmentVerified;
}

export function registerEmailProviderConfigurationRoutes(app: Express) {
  app.get('/api/admin/store-email/providers', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => res.json(await listEmailProviderConfigurations())));
  app.put('/api/admin/store-email/providers/:provider', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const provider = String(req.params.provider ?? '').toUpperCase();
    if (!providerSet.has(provider)) throw Object.assign(new Error('Unsupported email provider.'), { statusCode: 404 });
    const input = configInput.parse(req.body);
    const current = await prisma.emailProviderConfiguration.findUnique({ where: { provider } });
    const username = input.username || current?.username || null;
    let previousPassword: string | null = null;
    if (current) {
      try { previousPassword = decrypt(current.passwordCiphertext); }
      catch { if (!input.password) throw Object.assign(new Error('The saved credential cannot be decrypted. Enter a replacement password/API credential before saving.'), { statusCode: 409 }); }
    }
    const password = input.password || previousPassword;
    if (Boolean(username) !== Boolean(password)) throw Object.assign(new Error('SMTP username and password/API credential must be supplied together.'), { statusCode: 400 });
    const user = res.locals.user as { id: string };
    const wasActive = (await prisma.platformEmailProviderSelection.findUnique({ where: { id: 'default' }, select: { provider: true } }))?.provider === provider;
    const saved = await prisma.$transaction(async tx => {
      const result = await tx.emailProviderConfiguration.upsert({
        where: { provider },
        create: { provider, host: input.host, port: input.port, secure: input.secure, requireTls: input.requireTls, username, passwordCiphertext: password ? encrypt(password) : null, senderName: input.senderName, senderEmail: input.senderEmail, replyTo: input.replyTo || null, updatedById: user.id },
        update: { host: input.host, port: input.port, secure: input.secure, requireTls: input.requireTls, username, passwordCiphertext: password ? encrypt(password) : null, senderName: input.senderName, senderEmail: input.senderEmail, replyTo: input.replyTo || null, verifiedAt: null, lastTestAt: null, lastTestCode: null, updatedById: user.id }
      });
      await tx.platformEmailProviderSelection.updateMany({ where: { id: 'default', provider }, data: { provider: null, updatedById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'EMAIL_PROVIDER_CONFIGURATION_UPDATED', entity: 'EmailProviderConfiguration', entityId: provider, metadata: { reason: input.reason, host: result.host, port: result.port, secure: result.secure, requireTls: result.requireTls, hadCredentials: Boolean(username && password), previousProviderDeactivated: wasActive } } });
      return result;
    });
    res.json({ saved: true, active: false, message: 'Provider settings saved. Test the connection, then activate it to use it for platform email.' });
  }));
  app.post('/api/admin/store-email/providers/:provider/test', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const input = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const provider = String(req.params.provider ?? '').toUpperCase();
    const user = res.locals.user as { id: string };
    try {
      const result = await verifyStoredEmailProvider(provider);
      await audit(user.id, 'EMAIL_PROVIDER_CONNECTION_TESTED', 'EmailProviderConfiguration', provider, { verified: true, testedAt: result.testedAt, reason: input.reason });
      res.json(result);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'EMAIL_PROVIDER_TEST_FAILED';
      await audit(user.id, 'EMAIL_PROVIDER_CONNECTION_TEST_FAILED', 'EmailProviderConfiguration', provider, { verified: false, code, reason: input.reason });
      throw error;
    }
  }));
  app.patch('/api/admin/store-email/providers/:provider/activation', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const provider = String(req.params.provider ?? '').toUpperCase();
    if (!providerSet.has(provider)) throw Object.assign(new Error('Unsupported email provider.'), { statusCode: 404 });
    const input = z.object({ active: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const user = res.locals.user as { id: string };
    await prisma.$transaction(async tx => {
      if (input.active) {
        await tx.$queryRaw`SELECT "provider" FROM "EmailProviderConfiguration" WHERE "provider" = ${provider} FOR UPDATE`;
        const row = await tx.emailProviderConfiguration.findUnique({ where: { provider }, select: { verifiedAt: true } });
        if (!row) throw Object.assign(new Error('Save and test this provider before activation.'), { statusCode: 409 });
        if (!row.verifiedAt || Date.now() - row.verifiedAt.getTime() >= verificationTtlMs) throw Object.assign(new Error('Test this provider successfully within the last 24 hours before activation.'), { statusCode: 409 });
        await tx.platformEmailProviderSelection.upsert({ where: { id: 'default' }, create: { id: 'default', provider, updatedById: user.id }, update: { provider, updatedById: user.id } });
      } else await tx.platformEmailProviderSelection.updateMany({ where: { id: 'default', provider }, data: { provider: null, updatedById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: input.active ? 'EMAIL_PROVIDER_ACTIVATED' : 'EMAIL_PROVIDER_DEACTIVATED', entity: 'EmailProviderConfiguration', entityId: provider, metadata: { reason: input.reason, active: input.active } } });
    });
    res.json({ activeProvider: input.active ? provider : null, message: input.active ? 'Provider activated for platform transactional and marketing email.' : 'Dashboard provider deactivated; deployment SMTP will be used if configured.' });
  }));
}
