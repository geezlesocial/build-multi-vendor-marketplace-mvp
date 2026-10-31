import { describe, expect, it } from 'vitest';
import { defaultSiteChrome, paidChromeSnapshotIsEligible, siteChromeSchema, storeChromePageKeys } from './site-chrome-domain.js';

describe('site chrome configuration', () => {
  it('allows the selected Store homepage and product pages as stable suppression keys', () => {
    expect([...storeChromePageKeys]).toEqual(['STORE_HOME', 'STORE_PRODUCT']);
  });

  it('provides the original-compatible default with three header and footer template choices', () => {
    const configuration = defaultSiteChrome();
    expect(configuration.header.template).toBe('CLASSIC');
    expect(configuration.footer.template).toBe('MINIMAL');
    expect(siteChromeSchema.parse({ ...configuration, header: { ...configuration.header, template: 'EDITORIAL' } }).header.template).toBe('EDITORIAL');
    expect(siteChromeSchema.parse({ ...configuration, header: { ...configuration.header, template: 'COMMERCE' }, footer: { ...configuration.footer, template: 'BUSINESS' } }).footer.template).toBe('BUSINESS');
    expect(siteChromeSchema.parse({ ...configuration, footer: { ...configuration.footer, template: 'SIGNATURE' } }).footer.template).toBe('SIGNATURE');
  });

  it('rejects scriptable, protocol-relative, and credential-bearing navigation URLs', () => {
    const configuration = defaultSiteChrome();
    for (const href of ['javascript:alert(1)', '//attacker.example', 'https://user:pass@example.com']) {
      expect(() => siteChromeSchema.parse({ ...configuration, header: { ...configuration.header, navigation: [{ id: 'bad', label: 'Bad', href, enabled: true }] } })).toThrow();
    }
  });

  it('limits social profiles to six HTTPS destinations and rejects duplicate IDs and URLs', () => {
    const social = (id: string, url: string) => ({ id, platform: 'OTHER' as const, url, label: 'Profile', enabled: true, display: 'ICON_AND_LABEL' as const });
    expect(() => siteChromeSchema.parse({ ...defaultSiteChrome(), footer: { ...defaultSiteChrome().footer, socials: Array.from({ length: 7 }, (_, index) => social(`social-${index}`, `https://example.com/${index}`)) } })).toThrow();
    expect(() => siteChromeSchema.parse({ ...defaultSiteChrome(), footer: { ...defaultSiteChrome().footer, socials: [social('same', 'https://example.com/a'), social('same', 'https://example.com/b')] } })).toThrow(/unique/);
    expect(() => siteChromeSchema.parse({ ...defaultSiteChrome(), footer: { ...defaultSiteChrome().footer, socials: [social('a', 'https://example.com/a'), social('b', 'https://example.com/a')] } })).toThrow(/unique/);
  });

  it('rejects unsafe CSS values and duplicate footer visibility rules', () => {
    const base = defaultSiteChrome();
    expect(() => siteChromeSchema.parse({ ...base, header: { ...base.header, backgroundColor: 'red;url(javascript:alert(1))' } })).toThrow();
    expect(() => siteChromeSchema.parse({ ...base, suppressedPageKeys: ['PLATFORM_HOME', 'PLATFORM_HOME'] })).toThrow(/once/);
  });
});

describe('paid Store chrome access', () => {
  const now = new Date('2026-10-31T00:00:00.000Z');
  const validSnapshot = () => ({
    approvedSeller: true,
    platformStore: false,
    assignment: { status: 'ACTIVE', source: 'SUBSCRIPTION', planVersionId: 'plan-v2', effectiveFrom: new Date('2026-10-01T00:00:00.000Z'), effectiveUntil: null },
    subscription: { provider: 'STRIPE', providerSubscriptionId: 'sub_verified_fixture', status: 'ACTIVE', planVersionId: 'plan-v2', interval: 'MONTHLY', monthlyPriceMinor: 1200, annualPriceMinor: 12000, currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'), expiresAt: null }
  });

  it('allows only approved sellers with a current paid provider subscription and matching assignment', () => {
    expect(paidChromeSnapshotIsEligible(validSnapshot(), now)).toBe(true);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), approvedSeller: false }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), platformStore: true }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), assignment: { ...validSnapshot().assignment, source: 'ADMIN' } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, provider: null } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, providerSubscriptionId: null } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, monthlyPriceMinor: 0 } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, planVersionId: 'other' } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, interval: 'ANNUAL', annualPriceMinor: 12000 } }, now)).toBe(true);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, interval: 'ANNUAL', annualPriceMinor: 0 } }, now)).toBe(false);
  });

  it('revokes access for expired periods, elapsed assignment, trial, or missing subscription', () => {
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), assignment: { ...validSnapshot().assignment, effectiveUntil: new Date('2026-10-30T23:59:59.000Z') } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, currentPeriodEnd: new Date('2026-10-30T23:59:59.000Z') } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: { ...validSnapshot().subscription, status: 'TRIALING' } }, now)).toBe(false);
    expect(paidChromeSnapshotIsEligible({ ...validSnapshot(), subscription: null }, now)).toBe(false);
  });
});
