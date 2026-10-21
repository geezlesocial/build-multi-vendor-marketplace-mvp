import assert from 'node:assert/strict';
import test from 'node:test';
import { validateE2EBaseURL, validateE2EDatabaseURL } from './e2e-database-url.mjs';

test('accepts local browser base URLs', () => {
  for (const value of ['http://127.0.0.1:5173/', 'http://localhost:5173', 'https://[::1]:5173/test']) {
    const result = validateE2EBaseURL(value);
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(result.hostname));
  }
});

test('rejects remote or credential-bearing browser base URLs', () => {
  for (const value of ['https://staging.example.test/', 'http://user:password@127.0.0.1:5173/', 'ftp://127.0.0.1:5173/']) {
    assert.throws(() => validateE2EBaseURL(value), /E2E_BASE_URL/);
  }
});

test('accepts local disposable PostgreSQL URLs', () => {
  for (const value of [
    'postgresql://marketplace:marketplace@127.0.0.1:5432/marketplace_e2e_ci?schema=public',
    'postgres://marketplace:marketplace@localhost:5432/marketplace_test?schema=public',
    'postgresql://marketplace:marketplace@[::1]:5432/local-test-db'
  ]) {
    const result = validateE2EDatabaseURL(value);
    assert.match(result.databaseName, /(e2e|test)/i);
  }
});

test('rejects missing or malformed URLs', () => {
  for (const value of [undefined, '', 'not-a-url', 'https://127.0.0.1/marketplace_e2e']) {
    assert.throws(() => validateE2EDatabaseURL(value), /E2E_DATABASE_URL/);
  }
});

test('rejects remote hosts even when the database name looks disposable', () => {
  assert.throws(
    () => validateE2EDatabaseURL('postgresql://user:password@db.example.test:5432/marketplace_e2e'),
    /local disposable database host/
  );
});

test('rejects local databases without an e2e or test name', () => {
  assert.throws(
    () => validateE2EDatabaseURL('postgresql://marketplace:marketplace@127.0.0.1:5432/marketplace'),
    /database name must include e2e or test/
  );
});
