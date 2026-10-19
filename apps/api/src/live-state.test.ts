import { describe, expect, it } from 'vitest';
import { canTransition, effectiveLiveShoppingEnabled } from './live-state.js';
import { UnavailableLiveProvider } from './live-provider.js';

describe('live-shopping safety boundary', () => {
  it('requires every gate to be true', () => {
    expect(effectiveLiveShoppingEnabled({ deploymentGate: false, runtimeEnabled: true, providerConfigured: true, providerHealthy: true })).toBe(false);
    expect(effectiveLiveShoppingEnabled({ deploymentGate: true, runtimeEnabled: true, providerConfigured: false, providerHealthy: false })).toBe(false);
    expect(effectiveLiveShoppingEnabled({ deploymentGate: true, runtimeEnabled: true, providerConfigured: true, providerHealthy: true })).toBe(true);
  });

  it('rejects impossible lifecycle transitions', () => {
    expect(canTransition('DRAFT', 'SCHEDULED')).toBe(true);
    expect(canTransition('DRAFT', 'LIVE')).toBe(false);
    expect(canTransition('ENDED', 'LIVE')).toBe(false);
  });

  it('fails closed instead of simulating a provider', async () => {
    const provider = new UnavailableLiveProvider();
    await expect(provider.getReadiness()).resolves.toMatchObject({ configured: false, healthy: false });
    await expect(provider.createSession({ title: 'test' })).rejects.toThrow('real managed streaming provider');
  });
});
