export type LiveLifecycle = 'DRAFT' | 'SCHEDULED' | 'STARTING' | 'LIVE' | 'PAUSED' | 'ENDED' | 'CANCELLED' | 'FAILED';
export const REPLAY_DELETION_PENDING_ERROR_CODE = 'SELLER_REPLAY_DELETE_PENDING';

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

export function canDeleteLiveShow(status: LiveLifecycle, recordingStatus: string, recordingErrorCode?: string | null) {
  const broadcastActive = status === 'STARTING' || status === 'LIVE' || status === 'PAUSED';
  const recordingPending = recordingStatus === 'STARTING' || recordingStatus === 'RECORDING' || recordingStatus === 'PROCESSING';
  return !broadcastActive && !recordingPending && recordingErrorCode !== REPLAY_DELETION_PENDING_ERROR_CODE;
}

export function effectiveLiveShoppingEnabled(input: { deploymentGate: boolean; runtimeEnabled: boolean; providerConfigured: boolean; providerHealthy: boolean }) {
  return input.deploymentGate && input.runtimeEnabled && input.providerConfigured && input.providerHealthy;
}
