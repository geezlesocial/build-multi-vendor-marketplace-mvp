import { describe, expect, it } from 'vitest';
import { customDomainDnsReady, isPublicSmtpAddress, normalizeCustomDomain, normalizeDnsHostname, storeIntegrationEligible, tokenDigest } from './seller-integrations-domain.js';

describe('seller domain and SMTP safety rules', () => {
  it('normalizes public custom domains and blocks marketplace or reserved hosts', () => {
    expect(normalizeCustomDomain('WWW.Example-Store.co.uk.')).toBe('www.example-store.co.uk');
    expect(() => normalizeCustomDomain('shop.marketlane.com', ['marketlane.com'])).toThrow(/belongs to the marketplace/i);
    expect(() => normalizeCustomDomain('localhost')).toThrow(/public DNS hostname/i);
    expect(() => normalizeCustomDomain('127.0.0.1')).toThrow(/public DNS hostname/i);
    expect(() => normalizeDnsHostname('smtp.internal')).toThrow(/reserved test hostnames/i);
  });

  it('rejects SMTP resolutions to private, loopback, link-local, and reserved IP ranges', () => {
    for (const address of ['127.0.0.1', '10.0.0.2', '172.20.1.1', '192.168.1.8', '169.254.169.254', '100.64.0.1', '192.0.2.1', '203.0.113.8', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '2001:db8::1']) {
      expect(isPublicSmtpAddress(address), address).toBe(false);
    }
    expect(isPublicSmtpAddress('8.8.8.8')).toBe(true);
    expect(isPublicSmtpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('requires both the proof TXT record and expected CNAME to be present', () => {
    expect(customDomainDnsReady({ ownershipTokenMatches: true, cnameMatches: true })).toBe(true);
    expect(customDomainDnsReady({ ownershipTokenMatches: false, cnameMatches: true })).toBe(false);
    expect(customDomainDnsReady({ ownershipTokenMatches: true, cnameMatches: false })).toBe(false);
    expect(tokenDigest('ownership-proof')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gives the official admin Store integration access without a paid plan while preserving seller plan gates', () => {
    expect(storeIntegrationEligible({ isOfficialAdminStore: true, paidPlan: false, entitlementEnabled: false })).toBe(true);
    expect(storeIntegrationEligible({ isOfficialAdminStore: false, paidPlan: false, entitlementEnabled: true })).toBe(false);
    expect(storeIntegrationEligible({ isOfficialAdminStore: false, paidPlan: true, entitlementEnabled: false })).toBe(false);
    expect(storeIntegrationEligible({ isOfficialAdminStore: false, paidPlan: true, entitlementEnabled: true })).toBe(true);
  });
});
