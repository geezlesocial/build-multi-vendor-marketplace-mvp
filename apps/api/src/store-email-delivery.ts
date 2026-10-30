import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from './config.js';
import { emailSettingsVerified, resolvePlatformEmailSettings, verifyActiveEmailProvider, type EffectiveEmailSettings } from './store-email-provider-config.js';
import { createSellerSmtpTransport, resolveSellerStoreEmailSettings } from './seller-store-integrations.js';

const paragraphSchema = z.array(z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000).refine(value => !/[<>]/.test(value)) }).strict()).min(1).max(30);

type SmtpTransport = ReturnType<typeof nodemailer.createTransport>;

let cachedTransport: SmtpTransport | null = null;
let cachedSettingsKey = '';
let smtpVerifiedAt: Date | null = null;
const verificationTtlMs = 24 * 60 * 60_000;

export class StoreEmailTransportError extends Error {
  constructor(readonly code: 'EMAIL_PROVIDER_NOT_CONFIGURED' | 'EMAIL_CONNECTION_FAILED' | 'EMAIL_AUTH_FAILED') {
    super(code === 'EMAIL_AUTH_FAILED' ? 'The configured email provider rejected its credentials.' : code === 'EMAIL_CONNECTION_FAILED' ? 'The configured email provider could not complete the operation.' : 'Store email delivery is not configured and enabled.');
    this.name = 'StoreEmailTransportError';
  }
}

export async function storeEmailProviderStatus() {
  const settings = await resolvePlatformEmailSettings();
  const transactionalConfigured = hasValidTransportSettings(settings);
  const configured = Boolean(transactionalConfigured && env.STORE_EMAIL_TOKEN_SECRET);
  const connectionVerified = emailSettingsVerified(settings, smtpConnectionVerified());
  return {
    configured,
    transactionalConfigured,
    enabled: env.STORE_EMAIL_DELIVERY_AVAILABLE && configured && connectionVerified,
    deploymentGate: env.STORE_EMAIL_DELIVERY_AVAILABLE,
    connectionVerified,
    verifiedAt: connectionVerified ? (settings.source === 'ADMIN_DASHBOARD' ? settings.verifiedAt?.toISOString() ?? null : smtpVerifiedAt?.toISOString() ?? null) : null,
    hostConfigured: Boolean(settings.host),
    host: settings.host || null,
    provider: settings.provider || null,
    providerLabel: settings.providerLabel || null,
    configurationSource: settings.source,
    port: settings.port,
    secureTransport: settings.secure || settings.requireTls,
    authenticationConfigured: Boolean(settings.username && settings.password),
    senderConfigured: Boolean(settings.senderEmail),
    replyToConfigured: Boolean(settings.replyTo),
    unsubscribeSigningConfigured: Boolean(env.STORE_EMAIL_TOKEN_SECRET),
    message: !transactionalConfigured
      ? 'Configure and verify an SMTP provider below. Store marketing also requires the deployment unsubscribe-signing secret.'
      : !env.STORE_EMAIL_TOKEN_SECRET
        ? 'SMTP is ready for transactional email; Store marketing still needs the deployment unsubscribe-signing secret.'
      : !env.STORE_EMAIL_DELIVERY_AVAILABLE
        ? 'SMTP settings are present, but marketing remains disabled by the deployment gate.'
        : connectionVerified
          ? 'SMTP is configured and verified. The marketing deployment gate is enabled.'
          : 'SMTP is configured and the deployment gate is enabled. An administrator must verify the connection before subscription or campaign delivery.'
  };
}

export async function storeEmailProviderStatusForStore(storeId: string) {
  const sellerSettings = await resolveSellerStoreEmailSettings(storeId);
  if (!sellerSettings) return storeEmailProviderStatus();
  const enabled = env.STORE_EMAIL_DELIVERY_AVAILABLE && Boolean(env.STORE_EMAIL_TOKEN_SECRET)
    && emailSettingsVerified(sellerSettings, false) && hasValidTransportSettings(sellerSettings);
  return {
    configured: enabled,
    transactionalConfigured: false,
    enabled,
    deploymentGate: env.STORE_EMAIL_DELIVERY_AVAILABLE,
    connectionVerified: emailSettingsVerified(sellerSettings, false),
    verifiedAt: sellerSettings.verifiedAt?.toISOString() ?? null,
    hostConfigured: Boolean(sellerSettings.host),
    host: sellerSettings.host || null,
    provider: sellerSettings.provider,
    providerLabel: sellerSettings.providerLabel,
    configurationSource: 'SELLER_STORE',
    port: sellerSettings.port,
    secureTransport: sellerSettings.secure || sellerSettings.requireTls,
    authenticationConfigured: Boolean(sellerSettings.username && sellerSettings.password),
    senderConfigured: Boolean(sellerSettings.senderEmail),
    replyToConfigured: Boolean(sellerSettings.replyTo),
    unsubscribeSigningConfigured: Boolean(env.STORE_EMAIL_TOKEN_SECRET),
    message: enabled
      ? 'Your verified Store SMTP is active for consent-based Store email.'
      : 'Store SMTP is verified, but the platform email-delivery gate or unsubscribe-signing secret is not configured.'
  };
}

function hasValidTransportSettings(settings: EffectiveEmailSettings) {
  return Boolean(settings.host && settings.senderEmail && (settings.secure || settings.requireTls) && !settings.credentialError && (Boolean(settings.username) === Boolean(settings.password)));
}

async function transport() {
  const settings = await resolvePlatformEmailSettings();
  if (!hasValidTransportSettings(settings)) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  const settingsKey = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  if (!cachedTransport || cachedSettingsKey !== settingsKey) {
    cachedTransport?.close();
    cachedTransport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTls,
      ...(settings.username && settings.password ? { auth: { user: settings.username, pass: settings.password } } : {}),
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      maxRecipients: 1
    });
    cachedSettingsKey = settingsKey;
  }
  return { smtp: cachedTransport, settings };
}

function smtpConnectionVerified() {
  const valid = Boolean(smtpVerifiedAt && Date.now() - smtpVerifiedAt.getTime() < verificationTtlMs);
  if (!valid) smtpVerifiedAt = null;
  return valid;
}

export async function accountVerificationEmailStatus() {
  const settings = await resolvePlatformEmailSettings();
  const configured = hasValidTransportSettings(settings);
  const connectionVerified = emailSettingsVerified(settings, smtpConnectionVerified());
  return { configured, connectionVerified, available: configured && connectionVerified };
}

export async function verifyStoreEmailSmtp() {
  smtpVerifiedAt = null;
  const settings = await resolvePlatformEmailSettings();
  if (!hasValidTransportSettings(settings)) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  try {
    if (settings.source === 'ADMIN_DASHBOARD') await verifyActiveEmailProvider();
    else {
      const { smtp } = await transport();
      await smtp.verify();
      smtpVerifiedAt = new Date();
    }
  }
  catch (error) { throw safeTransportError(error); }
  return { verified: true as const };
}

function safeTransportError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code).toUpperCase() : '';
  return new StoreEmailTransportError(code === 'EAUTH' || code === 'AUTH' ? 'EMAIL_AUTH_FAILED' : 'EMAIL_CONNECTION_FAILED');
}

export function escapeEmailHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function footer(unsubscribeUrl: string) {
  return {
    text: `\n\nYou are receiving this message because you subscribed to store updates. Unsubscribe: ${unsubscribeUrl}`,
    html: `<hr><p style="color:#59645e;font-size:12px">You are receiving this message because you subscribed to store updates. <a href="${escapeEmailHtml(unsubscribeUrl)}">Unsubscribe</a></p>`
  };
}

async function send(to: string, subject: string, text: string, html: string, unsubscribeUrl?: string, messageId?: string, storeId?: string) {
  const sellerSettings = storeId ? await resolveSellerStoreEmailSettings(storeId) : null;
  if (sellerSettings) {
    if (!(await storeEmailProviderStatusForStore(storeId!)).enabled) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  } else if (!(await storeEmailProviderStatus()).enabled) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  const headers = unsubscribeUrl ? {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  } : undefined;
  let sellerTransport: SmtpTransport | null = null;
  try {
    const platform = sellerSettings ? null : await transport();
    const settings = sellerSettings ?? platform!.settings;
    const smtp = sellerSettings ? (sellerTransport = await createSellerSmtpTransport(sellerSettings)) : platform!.smtp;
    await smtp.sendMail({
      from: { name: settings.senderName || 'Store updates', address: settings.senderEmail },
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      to,
      subject,
      text,
      html,
      ...(messageId ? { messageId } : {}),
      ...(headers ? { headers } : {})
    });
  } catch (error) { throw safeTransportError(error); }
  finally { sellerTransport?.close(); }
}

export async function sendStoreEmailConfirmation(input: { to: string; storeId: string; storeName: string; token: string }) {
  const confirmUrl = `${env.WEB_ORIGIN.replace(/\/$/, '')}/email/confirm?token=${encodeURIComponent(input.token)}`;
  const storeName = escapeEmailHtml(input.storeName);
  await send(input.to, `Confirm email updates from ${input.storeName}`, `Confirm that you want to receive email updates from ${input.storeName} by opening this link: ${confirmUrl}\n\nThis link expires in 48 hours. If you did not request this, you can ignore this message.`, `<main><h1>Confirm your subscription</h1><p>Confirm that you want to receive email updates from <strong>${storeName}</strong>.</p><p><a href="${escapeEmailHtml(confirmUrl)}">Confirm email updates</a></p><p>This link expires in 48 hours. If you did not request this, you can ignore this message.</p></main>`, undefined, undefined, input.storeId);
}

/** Transactional account verification is separate from optional, consent-based Store marketing delivery. */
export async function sendAccountVerificationEmail(input: { to: string; name: string; token: string }) {
  if (!(await accountVerificationEmailStatus()).available) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  const verifyUrl = `${env.WEB_ORIGIN.replace(/\/$/, '')}/email/verify?token=${encodeURIComponent(input.token)}`;
  const name = escapeEmailHtml(input.name);
  try {
    const { smtp, settings } = await transport();
    await smtp.sendMail({
      from: { name: `${settings.senderName || 'Market Lane'} account security`, address: settings.senderEmail },
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      to: input.to,
      subject: 'Verify your Market Lane email address',
      text: `Hello ${input.name},\n\nVerify your email address to secure your account and submit product reviews: ${verifyUrl}\n\nThis one-time link expires in 24 hours. If you did not create this account, you can ignore this email.`,
      html: `<main><h1>Verify your email</h1><p>Hello ${name},</p><p>Verify your email address to secure your account and submit product reviews.</p><p><a href="${escapeEmailHtml(verifyUrl)}">Verify email address</a></p><p>This one-time link expires in 24 hours. If you did not create this account, you can ignore this email.</p></main>`
    });
  } catch (error) { throw safeTransportError(error); }
}

/** Send transactional order/support/account notices. Marketing consent and its deployment gate do not apply. */
export async function sendTransactionalNotificationEmail(input: { to: string; subject: string; text: string; html: string; messageId: string }) {
  if (!(await accountVerificationEmailStatus()).available) throw new StoreEmailTransportError('EMAIL_PROVIDER_NOT_CONFIGURED');
  try {
    const { smtp, settings } = await transport();
    const result = await smtp.sendMail({
      from: { name: settings.senderName || 'Market Lane', address: settings.senderEmail },
      ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      messageId: input.messageId
    });
    return { messageId: result.messageId };
  } catch (error) { throw safeTransportError(error); }
}

export async function transactionalEmailMessageId(outboxId: string) {
  const settings = await resolvePlatformEmailSettings();
  return `<${outboxId}@${settings.host || 'marketplace.local'}>`;
}

export async function sendStoreEmailCampaign(input: { to: string; storeId: string; storeName: string; subject: string; content: unknown; unsubscribeToken: string; deliveryId: string }) {
  const content = paragraphSchema.parse(input.content);
  const unsubscribeApiUrl = `${env.SITE_URL.replace(/\/$/, '')}/api/store-email/unsubscribe/${encodeURIComponent(input.unsubscribeToken)}`;
  const unsubscribePageUrl = `${env.WEB_ORIGIN.replace(/\/$/, '')}/email/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`;
  const bodyText = content.map(block => block.text).join('\n\n');
  const bodyHtml = content.map(block => `<p>${escapeEmailHtml(block.text).replaceAll('\n', '<br>')}</p>`).join('');
  const end = footer(unsubscribePageUrl);
  const settings = await resolveSellerStoreEmailSettings(input.storeId) ?? await resolvePlatformEmailSettings();
  const messageId = `<${input.deliveryId}@${settings.host || 'marketplace.local'}>`;
  await send(input.to, input.subject, `${bodyText}${end.text}`, `<main><p><strong>${escapeEmailHtml(input.storeName)}</strong></p>${bodyHtml}${end.html}</main>`, unsubscribeApiUrl, messageId, input.storeId);
}

export function closeStoreEmailTransport() {
  cachedTransport?.close();
  cachedTransport = null;
  cachedSettingsKey = '';
  smtpVerifiedAt = null;
}
