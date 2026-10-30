export type LiveLifecycle = 'DRAFT' | 'SCHEDULED' | 'STARTING' | 'LIVE' | 'PAUSED' | 'ENDED' | 'CANCELLED' | 'FAILED';

export const liveTransitions: Record<LiveLifecycle, LiveLifecycle[]> = {
  DRAFT: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['DRAFT', 'STARTING', 'CANCELLED'],
  STARTING: ['LIVE', 'FAILED', 'CANCELLED'],
  LIVE: ['PAUSED', 'ENDED', 'FAILED'],
  PAUSED: ['LIVE', 'ENDED', 'FAILED'],
  ENDED: [],
  CANCELLED: [],
  FAILED: ['STARTING', 'CANCELLED']
};

export function canTransition(from: LiveLifecycle, to: LiveLifecycle) {
  return from === to || liveTransitions[from].includes(to);
}

export function canDeleteLiveShow(status: LiveLifecycle, recordingStatus: string) {
  const broadcastActive = status === 'STARTING' || status === 'LIVE' || status === 'PAUSED';
  const recordingPending = recordingStatus === 'STARTING' || recordingStatus === 'RECORDING' || recordingStatus === 'PROCESSING';
  return !broadcastActive && !recordingPending;
}

export function effectiveLiveShoppingEnabled(input: { deploymentGate: boolean; runtimeEnabled: boolean; providerConfigured: boolean; providerHealthy: boolean }) {
  return input.deploymentGate && input.runtimeEnabled && input.providerConfigured && input.providerHealthy;
}
