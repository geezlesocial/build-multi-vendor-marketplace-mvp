import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clubCoinsHardDisabledSchema, isDisposableWalletFundingDatabaseUrl, parseClubCoinsHardDisabled } from './wallet-safety.js';

const currentRunId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const previousRunId = '00112233445566778899aabbccddeeff';
const disposableName = `wallet_funding_test_${currentRunId}`;

describe('Club Coins hard-disable configuration', () => {
  it('defaults to disabled', () => {
    expect(parseClubCoinsHardDisabled(undefined)).toBe(true);
    expect(clubCoinsHardDisabledSchema.parse(undefined)).toBe(true);
  });

  it('accepts only explicit true and false values', () => {
    expect(parseClubCoinsHardDisabled('true')).toBe(true);
    expect(parseClubCoinsHardDisabled('false')).toBe(false);
    expect(parseClubCoinsHardDisabled(' TRUE ')).toBe(true);
    expect(parseClubCoinsHardDisabled(' False ')).toBe(false);
    expect(clubCoinsHardDisabledSchema.parse('false')).toBe(false);
  });

  it.each(['flase', '1', '0', 'yes', 'no', 'on', 'off', ''])('rejects unrecognized value %j', value => {
    expect(() => parseClubCoinsHardDisabled(value)).toThrow(/CLUB_COINS_HARD_DISABLED must be explicitly set/);
    expect(() => clubCoinsHardDisabledSchema.parse(value)).toThrow();
  });

  it('fails application configuration loading when the environment value is misspelled', () => {
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', "import('./src/config.ts')"
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://127.0.0.1:55432/wallet_funding_test_config_load',
        PASSWORD_PEPPER: 'synthetic-test-only-password-pepper',
        DOTENV_CONFIG_PATH: join(tmpdir(), 'codex-wallet-test-env-file-must-not-exist'),
        CLUB_COINS_HARD_DISABLED: 'flase'
      }
    });
    expect(child.status).not.toBe(0);
    expect(`${child.stdout}\n${child.stderr}`).toContain('CLUB_COINS_HARD_DISABLED');
  });
});

describe('wallet funding database target guard', () => {
  const url = (name: string, host = '127.0.0.1', port = 55432) => `postgresql://test_user:test_password@${host}:${port}/${name}`;

  it('rejects ordinary test-named databases without the per-run identity', () => {
    expect(isDisposableWalletFundingDatabaseUrl(url('wallet_funding_test'), currentRunId)).toBe(false);
    expect(isDisposableWalletFundingDatabaseUrl(url('marketplace_test'), currentRunId)).toBe(false);
  });

  it('rejects database identities left over from another run', () => {
    expect(isDisposableWalletFundingDatabaseUrl(url(`wallet_funding_test_${previousRunId}`), currentRunId)).toBe(false);
  });

  it.each(['marketplace', 'marketplace_staging', 'marketplace_production', 'production', 'staging'])('hard-denies reserved database %s even if allowlisted', databaseName => {
    expect(isDisposableWalletFundingDatabaseUrl(url(databaseName), currentRunId, databaseName)).toBe(false);
  });

  it('does not let an allowlist authorize a remote host', () => {
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName, 'db.example.test'), currentRunId, disposableName)).toBe(false);
  });

  it('rejects the default PostgreSQL service port even for a matching database identity', () => {
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName, 'localhost', 5432), currentRunId, disposableName)).toBe(false);
  });

  it('rejects malformed URLs and malformed sandbox identities', () => {
    expect(isDisposableWalletFundingDatabaseUrl('not a database url', currentRunId)).toBe(false);
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName), 'not-a-run-id')).toBe(false);
  });

  it('accepts only the matching per-run identity on loopback, subject to an optional restrictive allowlist', () => {
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName), currentRunId)).toBe(true);
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName), currentRunId, disposableName)).toBe(true);
    expect(isDisposableWalletFundingDatabaseUrl(url(disposableName), currentRunId, 'another_database')).toBe(false);
  });
});
