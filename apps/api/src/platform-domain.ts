import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from './config.js';
import { MobileStorefrontTemplate, StoreThemePreset } from '@prisma/client';

export const brandingSchema = z.object({
  platformName: z.string().trim().min(1).max(100),
  shortName: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).default(''),
  seoDescription: z.string().trim().max(320).default(''),
  tagline: z.string().trim().max(160).default(''),
  logoMediaId: z.string().min(1).max(80).nullable().default(null),
  alternateLogoMediaId: z.string().min(1).max(80).nullable().default(null),
  faviconMediaId: z.string().min(1).max(80).nullable().default(null),
  defaultAvatarMediaId: z.string().min(1).max(80).nullable().default(null),
  socialImageMediaId: z.string().min(1).max(80).nullable().default(null),
  supportEmail: z.string().email().max(320).nullable().default(null),
  supportUrl: z.string().url().max(1000).nullable().default(null)
}).strict();

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hexadecimal color');
const themeSection = z.object({
  type: z.enum(['featuredProducts', 'categories', 'promotion', 'productCollection']),
  title: z.string().trim().max(120),
  productIds: z.array(z.string().min(1).max(80)).max(50).default([])
}).strict();

export const storeThemeSchema = z.object({
  themePreset: z.nativeEnum(StoreThemePreset).default(StoreThemePreset.CLASSIC),
  mobileTemplate: z.nativeEnum(MobileStorefrontTemplate).default(MobileStorefrontTemplate.RESPONSIVE_STANDARD),
  logoMediaId: z.string().min(1).max(80).nullable().default(null),
  faviconMediaId: z.string().min(1).max(80).nullable().default(null),
  bannerMediaId: z.string().min(1).max(80).nullable().default(null),
  description: z.string().trim().max(1000).default(''),
  primaryColor: hex.default('#1f6f5b'),
  accentColor: hex.default('#e7b75a'),
  font: z.enum(['system', 'serif', 'rounded']).default('system'),
  sections: z.array(themeSection).max(12).default([]),
  contactLinks: z.array(z.object({ label: z.string().trim().min(1).max(80), url: z.string().url().max(1000) }).strict()).max(10).default([])
}).strict();

export const storeSettingsSchema = storeThemeSchema.extend({
  name: z.string().trim().min(1).max(120).optional()
}).strict();

export const taxonomySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(500).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE'),
  displayOrder: z.number().int().min(0).max(100000).default(0),
  parentId: z.string().min(1).max(80).nullable().optional()
}).strict();

export const payoutMethodSchema = z.object({
  type: z.enum(['MANUAL_BANK', 'MANUAL_EWALLET', 'STRIPE_CONNECT', 'PAYPAL_PAYOUTS']),
  country: z.string().trim().length(2).transform(value => value.toUpperCase()),
  currency: z.string().trim().length(3).transform(value => value.toUpperCase()),
  label: z.string().trim().min(1).max(120),
  identifier: z.string().trim().min(3).max(240).optional(),
  details: z.record(z.string(), z.string().trim().max(300)).optional()
}).strict();

export const platformSettingsSchema = z.object({
  sellerShippingEnabled: z.boolean().optional(),
  codMaxMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  sellerApprovalPolicy: z.enum(['MANUAL', 'AUTOMATIC']).optional(),
  productApprovalPolicy: z.enum(['MANUAL', 'AUTOMATIC']).optional(),
  sellerPayoutsEnabled: z.boolean().optional(),
  payoutFundingConfigured: z.boolean().optional(),
  manualBankPayoutsEnabled: z.boolean().optional(),
  manualEwalletPayoutsEnabled: z.boolean().optional(),
  stripeConnectPayoutsEnabled: z.boolean().optional(),
  paypalPayoutsEnabled: z.boolean().optional(),
  payoutHoldDays: z.number().int().min(0).max(365).optional(),
  payoutMinimumMinor: z.number().int().min(0).max(2_000_000_000).optional(),
  reason: z.string().trim().max(500).optional()
}).strict();

export function payoutEncryptionKey() {
  return crypto.createHash('sha256').update(env.PAYOUT_ENCRYPTION_KEY ?? `${env.PASSWORD_PEPPER}:local-payout-key`).digest();
}

export function encryptPayoutDetails(value: Record<string, string>) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', payoutEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptPayoutDetails(value: string) {
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Invalid payout details');
  const decipher = crypto.createDecipheriv('aes-256-gcm', payoutEncryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')) as Record<string, string>;
}

export function maskIdentifier(value: string) {
  const compact = value.replace(/\s+/g, '');
  return compact.length <= 4 ? `••••${compact}` : `${'•'.repeat(Math.min(8, compact.length - 4))}${compact.slice(-4)}`;
}

export function payoutMethodEnabled(type: string, settings: { manualBankPayoutsEnabled: boolean; manualEwalletPayoutsEnabled: boolean; stripeConnectPayoutsEnabled: boolean; paypalPayoutsEnabled: boolean }) {
  return type === 'MANUAL_BANK' ? settings.manualBankPayoutsEnabled : type === 'MANUAL_EWALLET' ? settings.manualEwalletPayoutsEnabled : type === 'STRIPE_CONNECT' ? settings.stripeConnectPayoutsEnabled : settings.paypalPayoutsEnabled;
}

export function payoutStatusTransitionAllowed(current: string, next: string) {
  const transitions: Record<string, string[]> = {
    REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['PROCESSING', 'PAID', 'FAILED'],
    PROCESSING: ['PAID', 'FAILED', 'RETURNED'],
    FAILED: ['REQUESTED', 'CANCELLED'],
    RETURNED: ['REQUESTED', 'REVERSED'],
    PAID: ['REVERSED'],
    PENDING: ['ELIGIBLE', 'HELD', 'CANCELLED'],
    ELIGIBLE: ['REQUESTED', 'HELD', 'CANCELLED'],
    HELD: ['ELIGIBLE', 'CANCELLED']
  };
  return transitions[current]?.includes(next) ?? false;
}

export function reservedStoreSlug(slug: string) {
  return new Set(['admin', 'api', 'login', 'checkout', 'cart', 'seller', 'stores', 'content', 'blog', 'pages']).has(slug);
}

export function storeSlugFromName(name: string) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function safePayoutMethod(method: { id: string; type: string; status: string; country: string; currency: string; label: string; maskedIdentifier: string | null; providerAccountRef: string | null; providerRecipientRef: string | null; providerStatus: string | null; isDefault: boolean; createdAt: Date; updatedAt: Date }) {
  return { id: method.id, type: method.type, status: method.status, country: method.country, currency: method.currency, label: method.label, maskedIdentifier: method.maskedIdentifier, providerConfigured: Boolean(method.providerAccountRef || method.providerRecipientRef), providerStatus: method.providerStatus, isDefault: method.isDefault, createdAt: method.createdAt, updatedAt: method.updatedAt };
}
