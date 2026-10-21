import 'dotenv/config';
import { z } from 'zod';
import { clubCoinsHardDisabledSchema, isDisposableWalletFundingDatabaseUrl } from './wallet-safety.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default('marketplace_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  PASSWORD_PEPPER: z.string().min(16),
  CURRENCY: z.string().length(3).default('USD'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_BASE_URL: z.string().url().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  UPLOAD_DIR: z.string().default('uploads'),
  LIVE_SHOPPING_AVAILABLE: z.string().optional().default('false').transform(value => ['true', '1', 'yes', 'on'].includes(value.toLowerCase())),
  SITE_URL: z.string().url().default('http://localhost:4000'),
  CONTENT_STORAGE_DIR: z.string().default('storage/content'),
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
});

export const env = envSchema.parse(process.env);

export function isDisposableDatabaseUrl(databaseUrl: string, allowlist = env.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST) {
  return isDisposableWalletFundingDatabaseUrl(databaseUrl, env.WALLET_FUNDING_SANDBOX_ID, allowlist);
}
