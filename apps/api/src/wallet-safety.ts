import { z } from 'zod';

const SANDBOX_ID_PATTERN = /^[a-f0-9]{32}$/;
const DISPOSABLE_DATABASE_PATTERN = /^wallet_funding_(?:test|e2e)_([a-f0-9]{32})$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const RESERVED_DATABASE_NAMES = new Set([
  'marketplace',
  'marketplace_dev',
  'marketplace_test',
  'marketplace_staging',
  'marketplace_stage',
  'marketplace_production',
  'marketplace_prod',
  'staging',
  'stage',
  'production',
  'prod'
]);

function isReservedDatabaseName(databaseName: string) {
  const normalized = databaseName.toLowerCase().replaceAll('-', '_');
  return RESERVED_DATABASE_NAMES.has(normalized) || /^(?:marketplace|staging|stage|production|prod)(?:_|$)/.test(normalized);
}

export const clubCoinsHardDisabledSchema = z.preprocess(
  value => value === undefined ? 'true' : typeof value === 'string' ? value.trim().toLowerCase() : value,
  z.enum(['true', 'false'], { error: 'CLUB_COINS_HARD_DISABLED must be explicitly set to true or false' })
    .transform(value => value === 'true')
);

export function parseClubCoinsHardDisabled(value: string | undefined): boolean {
  return clubCoinsHardDisabledSchema.parse(value);
}

/**
 * This is a deny-first target guard, not proof that a database is disposable.
 * A fresh random identity must be generated for every run and used in both the
 * database name and WALLET_FUNDING_SANDBOX_ID. An allowlist can narrow targets,
 * but can never make a remote, reserved, default-port, or mismatched target safe.
 */
export function isDisposableWalletFundingDatabaseUrl(
  databaseUrl: string,
  sandboxId: string | undefined,
  allowlist = ''
) {
  if (!sandboxId || !SANDBOX_ID_PATTERN.test(sandboxId)) return false;

  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
    if (!parsed.port || parsed.port === '5432') return false;

    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!databaseName || databaseName.includes('/') || isReservedDatabaseName(databaseName)) return false;

    const identityMatch = DISPOSABLE_DATABASE_PATTERN.exec(databaseName);
    if (!identityMatch || identityMatch[1] !== sandboxId) return false;

    const allowedNames = allowlist.split(',').map(name => name.trim()).filter(Boolean);
    return allowedNames.length === 0 || allowedNames.includes(databaseName);
  } catch {
    return false;
  }
}
