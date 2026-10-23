import rateLimit from 'express-rate-limit';
import { isDisposableWalletFundingDatabaseUrl } from './wallet-safety.js';

export const AUTH_CREDENTIAL_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_CREDENTIAL_LIMIT = 60;
export const API_REQUEST_LIMIT_WINDOW_MS = 60 * 1000;
export const API_REQUEST_LIMIT = 300;
export const E2E_API_REQUEST_LIMIT = 1200;
export const E2E_AUTH_CREDENTIAL_LIMIT = 300;

type RateLimitOptions = {
  credentialLimit?: number;
  apiLimit?: number;
};

type RateLimitEnvironment = {
  NODE_ENV?: string;
  E2E_API_RATE_LIMIT_OVERRIDE?: string;
  DATABASE_URL?: string;
  E2E_DATABASE_URL?: string;
  WALLET_FUNDING_SANDBOX_ID?: string;
  WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST?: string;
};

/** Opt into larger, still-bounded request budgets only for the isolated E2E server. */
export function resolveApiRateLimitOptions(environment: RateLimitEnvironment): RateLimitOptions {
  if (environment.E2E_API_RATE_LIMIT_OVERRIDE !== 'true') return {};

  const databaseUrl = environment.DATABASE_URL;
  const isExactE2EDatabase = Boolean(databaseUrl)
    && environment.E2E_DATABASE_URL === databaseUrl
    && environment.NODE_ENV !== 'production'
    && isDisposableWalletFundingDatabaseUrl(
      databaseUrl!,
      environment.WALLET_FUNDING_SANDBOX_ID,
      environment.WALLET_FUNDING_DISPOSABLE_DATABASE_ALLOWLIST ?? ''
    );
  if (!isExactE2EDatabase) {
    throw new Error('E2E API rate-limit override requires the validated per-run disposable E2E database');
  }

  return {
    apiLimit: E2E_API_REQUEST_LIMIT,
    credentialLimit: E2E_AUTH_CREDENTIAL_LIMIT
  };
}

/**
 * Keep credential guessing throttled separately from ordinary session reads.
 * Production keeps the documented defaults; the only larger API budget is
 * resolved by the database-guarded E2E opt-in below.
 */
export function createApiRateLimiters(options: RateLimitOptions = {}) {
  return {
    credentialLimiter: rateLimit({
      windowMs: AUTH_CREDENTIAL_LIMIT_WINDOW_MS,
      limit: options.credentialLimit ?? AUTH_CREDENTIAL_LIMIT,
      standardHeaders: true,
      legacyHeaders: false
    }),
    apiLimiter: rateLimit({
      windowMs: API_REQUEST_LIMIT_WINDOW_MS,
      limit: options.apiLimit ?? API_REQUEST_LIMIT,
      standardHeaders: true,
      legacyHeaders: false
    })
  };
}
