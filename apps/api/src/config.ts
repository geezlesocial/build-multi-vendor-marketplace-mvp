import 'dotenv/config';
import { z } from 'zod';
import { clubCoinsHardDisabledSchema, isDisposableWalletFundingDatabaseUrl } from './wallet-safety.js';
import { liveProviderConfigurationsAvailableSchema } from './provider-configuration-gate.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default('marketplace_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  PASSWORD_PEPPER: z.string().min(16),
  CURRENCY: z.string().length(3).default('USD'),
  FX_REFERENCE_FETCH_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  FX_REFERENCE_API_BASE_URL: z.string().url().default('https://api.frankfurter.dev/v2'),
  FX_REFERENCE_MAX_AGE_HOURS: z.coerce.number().int().min(24).max(72).default(36),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // SaaS Store billing is a separate Stripe integration and remains off unless
  // explicitly configured for non-production test mode.
  STORE_PLAN_BILLING_SANDBOX_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  STRIPE_STORE_BILLING_SECRET_KEY: z.string().optional(),
  STRIPE_STORE_BILLING_WEBHOOK_SECRET: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_BASE_URL: z.string().url().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  LIVE_PROVIDER_CONFIGURATIONS_AVAILABLE: liveProviderConfigurationsAvailableSchema,
  UPLOAD_DIR: z.string().default('uploads'),
  LIVE_SHOPPING_AVAILABLE: z.string().optional().default('false').transform(value => ['true', '1', 'yes', 'on'].includes(value.toLowerCase())),
  SITE_URL: z.string().url().default('http://localhost:4000'),
  CONTENT_STORAGE_DIR: z.string().default('storage/content'),
  CONTENT_OBJECT_STORAGE_AVAILABLE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CONTENT_OBJECT_STORAGE_BUCKET: z.string().trim().min(1).optional(),
  CONTENT_OBJECT_STORAGE_REGION: z.string().trim().min(1).optional(),
  CONTENT_OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  CONTENT_SCANNER_AVAILABLE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CONTENT_SCANNER_HOST: z.string().trim().min(1).optional(),
  CONTENT_SCANNER_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CONTENT_SCANNER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  STORE_BUSTER_SPONSORED_AVAILABLE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  STORE_EMAIL_DELIVERY_AVAILABLE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  CONTENT_SCAN_REQUIRED: z.string().optional().default('true').transform(value => !['false', '0', 'no', 'off'].includes(value.toLowerCase())),
  CONTENT_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5_000_000),
  CONTENT_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(50_000_000),
  CONTENT_MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(10_000_000),
  AFFILIATE_DEFAULT_BASIS_POINTS: z.coerce.number().int().min(0).max(10000).default(500),
  AFFILIATE_SIGNING_SECRET: z.string().min(32).optional(),
  PAYOUT_ENCRYPTION_KEY: z.string().min(32).optional(),
  MONEY_MOVEMENT_HARD_DISABLED: z.string().optional().default('true').transform(value => !['false', '0', 'no', 'off'].includes(value.toLowerCase())),
  WALLET_FUNDING_PROVIDER_READY: z.string().optional().default('false').transform(value => ['true', '1', 'yes', 'on'].includes(value.toLowerCase())),
  WALLET_FUNDING_SANDBOX_MODE: z.string().optional().default('false').transform(value => ['true', '1', 'yes', 'on'].includes(value.toLowerCase())),
  WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST: z.string().optional().default(''),
  WALLET_FUNDING_SANDBOX_ID: z.string().optional().default(''),
  WALLET_FUNDING_TREASURY_ACCOUNT_ID: z.string().trim().min(1).optional(),
  CLUB_COINS_HARD_DISABLED: clubCoinsHardDisabledSchema
}).superRefine((value, context) => {
  if (value.STORE_PLAN_BILLING_SANDBOX_ENABLED) {
    if (value.NODE_ENV === 'production') {
      context.addIssue({ code: 'custom', path: ['STORE_PLAN_BILLING_SANDBOX_ENABLED'], message: 'Stripe Store billing sandbox cannot be enabled in production.' });
    }
    if (!value.STRIPE_STORE_BILLING_SECRET_KEY?.startsWith('sk_test_')) {
      context.addIssue({ code: 'custom', path: ['STRIPE_STORE_BILLING_SECRET_KEY'], message: 'Stripe Store billing requires a dedicated Stripe test-mode secret key.' });
    }
    if (!value.STRIPE_STORE_BILLING_WEBHOOK_SECRET || value.STRIPE_STORE_BILLING_WEBHOOK_SECRET.length < 16) {
      context.addIssue({ code: 'custom', path: ['STRIPE_STORE_BILLING_WEBHOOK_SECRET'], message: 'A dedicated Stripe Store billing webhook secret is required.' });
    }
  }
  if (value.CONTENT_OBJECT_STORAGE_AVAILABLE && (!value.CONTENT_OBJECT_STORAGE_BUCKET || !value.CONTENT_OBJECT_STORAGE_REGION)) {
    context.addIssue({ code: 'custom', path: ['CONTENT_OBJECT_STORAGE_BUCKET'], message: 'Object storage requires a bucket and region before it can be enabled.' });
  }
  if (value.CONTENT_SCANNER_AVAILABLE && !value.CONTENT_SCANNER_HOST) {
    context.addIssue({ code: 'custom', path: ['CONTENT_SCANNER_HOST'], message: 'A private ClamAV daemon host is required when the media scanner is enabled.' });
  }
});

export const env = envSchema.parse(process.env);

export function isDisposableDatabaseUrl(databaseUrl: string, allowlist = env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST) {
  return isDisposableWalletFundingDatabaseUrl(databaseUrl, env.WALLET_FUNDING_SANDBOX_ID, allowlist);
}
