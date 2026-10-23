import { describe, expect, it } from 'vitest';
import { liveProviderConfigurationsAvailableSchema } from './provider-configuration-gate.js';

describe('live provider configuration deployment gate', () => {
  it('defaults to blocked and accepts only explicit lowercase true/false', () => {
    expect(liveProviderConfigurationsAvailableSchema.parse(undefined)).toBe(false);
    expect(liveProviderConfigurationsAvailableSchema.parse('true')).toBe(true);
    expect(liveProviderConfigurationsAvailableSchema.parse('false')).toBe(false);
  });

  it.each(['TRUE', 'yes', '1', 'false ', ''])('rejects unsupported gate value %j', value => {
    expect(() => liveProviderConfigurationsAvailableSchema.parse(value)).toThrow();
  });
});
