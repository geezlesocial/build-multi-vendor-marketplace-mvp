import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { env } from './config.js';
import { hashPassword, verifyPassword } from './security.js';

describe('password hashing compatibility', () => {
  it('uses peppered pre-hashes so the bcrypt 72-byte limit cannot truncate a new password', async () => {
    const password = 'a long password that extends beyond bcrypt legacy input limits ' + 'x'.repeat(100);
    const encoded = await hashPassword(password);
    expect(encoded.startsWith('v2$')).toBe(true);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword(`${password}!`, encoded)).resolves.toBe(false);
  }, 15_000);

  it('continues to verify existing bcrypt(password + pepper) hashes', async () => {
    const password = 'ExistingDemoPassword-2026!';
    const legacyHash = await bcrypt.hash(`${password}${env.PASSWORD_PEPPER}`, 4);
    await expect(verifyPassword(password, legacyHash)).resolves.toBe(true);
    await expect(verifyPassword(`${password}!`, legacyHash)).resolves.toBe(false);
  });
});
