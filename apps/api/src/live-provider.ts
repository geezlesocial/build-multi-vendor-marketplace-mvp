export type LiveProviderReadiness = {
  provider: string | null;
  configured: boolean;
  healthy: boolean;
  reason: string;
};

export type LiveProviderSession = {
  providerSessionRef: string;
  playbackRef?: string;
  providerStatus?: string;
};

export interface LiveProviderAdapter {
  getReadiness(): Promise<LiveProviderReadiness>;
  createSession(input: { title: string; scheduledAt?: Date }): Promise<LiveProviderSession>;
  endSession(providerSessionRef: string): Promise<void>;
}

/** Production deliberately fails closed until the owner approves and configures a provider. */
export class UnavailableLiveProvider implements LiveProviderAdapter {
  async getReadiness(): Promise<LiveProviderReadiness> {
    return { provider: null, configured: false, healthy: false, reason: 'No managed streaming provider is selected. Owner approval and provider credentials are required.' };
  }

  async createSession(_input: { title: string; scheduledAt?: Date }): Promise<LiveProviderSession> {
    throw new Error('Live provider is unavailable; a real managed streaming provider must be configured before creating a session.');
  }

  async endSession(): Promise<void> {
    // No provider call is possible. Historical records remain untouched.
  }
}

export const liveProvider: LiveProviderAdapter = new UnavailableLiveProvider();
