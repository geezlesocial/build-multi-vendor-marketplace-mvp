import { describe, expect, it } from 'vitest';
import { callbackUrl, parseSocialProfile, safeScrolithIssuer, stateCookieName } from './social-auth-domain.js';

describe('social authentication boundary helpers', () => {
  it('normalizes Google and OIDC profile claims while preserving verified-email status', () => {
    expect(parseSocialProfile('GOOGLE', { sub: 'google-subject', email: 'BUYER@EXAMPLE.COM', email_verified: true, name: 'Buyer Name' })).toEqual({
      subject: 'google-subject', email: 'buyer@example.com', name: 'Buyer Name', emailVerified: true
    });
    expect(parseSocialProfile('LINKEDIN', { sub: 'linkedin-subject', email: 'buyer@example.com', name: 'Buyer' }).emailVerified).toBe(false);
  });

  it('requires X to return a confirmed email and accepts a Facebook email only as unverified', () => {
    expect(parseSocialProfile('X', { data: { id: 'x-123', name: 'Buyer', confirmed_email: 'buyer@example.com' } }).emailVerified).toBe(true);
    expect(() => parseSocialProfile('X', { data: { id: 'x-123', name: 'Buyer' } })).toThrow();
    expect(parseSocialProfile('FACEBOOK', { id: 'fb-123', name: 'Buyer', email: 'buyer@example.com' }).emailVerified).toBe(false);
  });

  it('only accepts HTTPS Scrolith issuer URLs on the official Scrolith domain', () => {
    expect(safeScrolithIssuer('https://auth.scrolith.com')).toBe(true);
    expect(safeScrolithIssuer('http://auth.scrolith.com')).toBe(false);
    expect(safeScrolithIssuer('https://scrolith.com.attacker.example')).toBe(false);
    expect(safeScrolithIssuer('https://127.0.0.1')).toBe(false);
    expect(safeScrolithIssuer('https://scrolith.com/path?next=attacker')).toBe(false);
  });

  it('uses the API origin and a state-specific callback cookie name', () => {
    expect(callbackUrl('http://localhost:4000/deploy-path', 'GOOGLE')).toBe('http://localhost:4000/api/auth/social/google/callback');
    expect(stateCookieName('0123456789abcdef0123456789abcdef')).toBe('oauth_state_0123456789abcdef');
  });
});
