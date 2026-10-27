import { describe, expect, it } from 'vitest';
import { onboardingCompletionBlock, onboardingCompletionSchema, referralSourceOptions } from './onboarding-domain.js';

describe('marketplace onboarding policy', () => {
  it('requires two distinct eligible follows and an available currency', () => {
    expect(onboardingCompletionBlock({ eligibleFollowCount: 0, currencyAvailable: true })?.code).toBe('ONBOARDING_STORES_REQUIRED');
    expect(onboardingCompletionBlock({ eligibleFollowCount: 1, currencyAvailable: true })?.code).toBe('ONBOARDING_STORES_REQUIRED');
    expect(onboardingCompletionBlock({ eligibleFollowCount: 2, currencyAvailable: false })?.code).toBe('ONBOARDING_CURRENCY_UNAVAILABLE');
    expect(onboardingCompletionBlock({ eligibleFollowCount: 2, currencyAvailable: true })).toBeNull();
  });

  it('accepts the published referral choices and trims optional Others detail', () => {
    expect(referralSourceOptions.map(option => option.label)).toContain('Introduced by a Friend');
    expect(onboardingCompletionSchema.parse({ displayCurrency: 'usd', referralSource: 'OTHER', referralOther: '  community event  ' })).toMatchObject({ displayCurrency: 'USD', referralOther: 'community event' });
    expect(onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'OTHER' }).referralOther).toBeUndefined();
  });

  it('rejects unknown sources, unexpected fields, overlong detail, and clarification for other choices', () => {
    expect(() => onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'UNKNOWN' })).toThrow();
    expect(() => onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'GOOGLE', referralOther: '<b>raw</b>' })).toThrow();
    expect(() => onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'OTHER', referralOther: '<script>bad</script>' })).toThrow();
    expect(() => onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'OTHER', referralOther: 'x'.repeat(121) })).toThrow();
    expect(() => onboardingCompletionSchema.parse({ displayCurrency: 'USD', referralSource: 'GOOGLE', userId: 'another-user' })).toThrow();
  });
});
