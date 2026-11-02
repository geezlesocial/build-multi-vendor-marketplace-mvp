import { describe, expect, it } from 'vitest';
import { canDeleteLiveShow, canTransition } from './live-state.js';

describe('seller live-show lifecycle controls', () => {
  it('allows sellers to publish a scheduled show and unpublish it back to draft', () => {
    expect(canTransition('DRAFT', 'SCHEDULED')).toBe(true);
    expect(canTransition('SCHEDULED', 'DRAFT')).toBe(true);
  });

  it('does not allow an active broadcast to be deleted before it is ended', () => {
    expect(canDeleteLiveShow('STARTING', 'NOT_CONFIGURED')).toBe(false);
    expect(canDeleteLiveShow('LIVE', 'RECORDING')).toBe(false);
    expect(canDeleteLiveShow('PAUSED', 'PROCESSING')).toBe(false);
  });

  it('allows inactive shows to be moved to the recoverable deleted-shows archive', () => {
    expect(canDeleteLiveShow('DRAFT', 'NOT_CONFIGURED')).toBe(true);
    expect(canDeleteLiveShow('SCHEDULED', 'FAILED')).toBe(true);
    expect(canDeleteLiveShow('ENDED', 'READY')).toBe(true);
  });

  it('waits for a pending replay recording before deleting a show', () => {
    expect(canDeleteLiveShow('ENDED', 'STARTING')).toBe(false);
    expect(canDeleteLiveShow('ENDED', 'RECORDING')).toBe(false);
    expect(canDeleteLiveShow('ENDED', 'PROCESSING')).toBe(false);
  });

  it('keeps a show recoverable while its replay deletion is pending', () => {
    expect(canDeleteLiveShow('ENDED', 'FAILED', 'SELLER_REPLAY_DELETE_PENDING')).toBe(false);
    expect(canDeleteLiveShow('ENDED', 'FAILED', 'SELLER_DELETED_REPLAY')).toBe(true);
  });
});
