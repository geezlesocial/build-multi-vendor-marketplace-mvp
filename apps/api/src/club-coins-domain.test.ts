import { describe, expect, it } from 'vitest';
import { clubCoinAwardAmount, clubCoinAwardIdempotencyKey, clubCoinBalanceAfterReversal, clubCoinEventAwardIdempotencyKey, clubCoinReversalIdempotencyKey, clubCoinRuleAppliesAt, creditLiveAttendance, isClubCoinPurchaseComplete, LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS } from './club-coins-domain.js';

describe('Club Coins purchase award policy', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  const activeRule = { enabled: true, effectiveFrom: null, effectiveTo: null, eligibleGroups: [], expiresAfterDays: null };

  it('applies only enabled rules within their configured time window', () => {
    expect(clubCoinRuleAppliesAt(activeRule, now)).toBe(true);
    expect(clubCoinRuleAppliesAt({ ...activeRule, enabled: false }, now)).toBe(false);
    expect(clubCoinRuleAppliesAt({ ...activeRule, effectiveFrom: new Date('2026-10-27T00:00:00Z') }, now)).toBe(false);
    expect(clubCoinRuleAppliesAt({ ...activeRule, effectiveTo: now }, now)).toBe(false);
  });

  it('fails closed for group-targeted and expiring rules until those services exist', () => {
    expect(clubCoinRuleAppliesAt({ ...activeRule, eligibleGroups: ['vip'] }, now)).toBe(false);
    expect(clubCoinRuleAppliesAt({ ...activeRule, expiresAfterDays: 30 }, now)).toBe(false);
  });

  it('applies lifetime, per-order, and daily caps to each award', () => {
    expect(clubCoinAwardAmount({ awardAmount: 10, perUserCap: 25, perOrderCap: 12, dailyCap: 20, userAwarded: 18, orderAwarded: 5, dailyAwarded: 8 })).toBe(7);
    expect(clubCoinAwardAmount({ awardAmount: 10, perUserCap: 5, perOrderCap: null, dailyCap: null, userAwarded: 5, orderAwarded: 0, dailyAwarded: 0 })).toBe(0);
    expect(clubCoinAwardAmount({ awardAmount: 10, perUserCap: null, perOrderCap: 12, dailyCap: null, userAwarded: 0, orderAwarded: 20, dailyAwarded: 0 })).toBe(0);
  });

  it('requires paid payment and receipt confirmation for every non-cancelled seller order', () => {
    const received = new Date();
    expect(isClubCoinPurchaseComplete({ method: 'STRIPE', status: 'PAID' }, [{ status: 'FULFILLED', receivedAt: received }])).toBe(true);
    expect(isClubCoinPurchaseComplete({ method: 'COD', status: 'PENDING' }, [{ status: 'FULFILLED', receivedAt: received }])).toBe(false);
    expect(isClubCoinPurchaseComplete({ method: 'PAYPAL', status: 'PAID' }, [{ status: 'FULFILLED', receivedAt: received }, { status: 'FULFILLED', receivedAt: null }])).toBe(false);
    expect(isClubCoinPurchaseComplete({ method: 'POS', status: 'PAID' }, [{ status: 'FULFILLED', receivedAt: received }])).toBe(false);
    expect(isClubCoinPurchaseComplete({ method: 'STRIPE', status: 'PAID' }, [{ status: 'CANCELLED', receivedAt: received }])).toBe(false);
  });

  it('uses stable, separate award and reversal idempotency keys', () => {
    expect(clubCoinAwardIdempotencyKey('rule1', 'order1')).toBe(clubCoinAwardIdempotencyKey('rule1', 'order1'));
    expect(clubCoinReversalIdempotencyKey('award1')).toBe('club-coins-reversal:award1');
    expect(clubCoinAwardIdempotencyKey('rule1', 'order1')).not.toBe(clubCoinReversalIdempotencyKey('award1'));
    expect(clubCoinEventAwardIdempotencyKey('rule1', 'ACCOUNT_VERIFIED', 'user1')).toBe('club-coins-award:rule1:user1:ACCOUNT_VERIFIED');
    expect(clubCoinEventAwardIdempotencyKey('rule1', 'PURCHASE_COMPLETED', 'order1')).toBe(clubCoinAwardIdempotencyKey('rule1', 'order1'));
  });

  it('records the full reversal even if coins were already spent, offsetting future non-cash awards', () => {
    expect(clubCoinBalanceAfterReversal(3, 10)).toBe(-7);
    expect(() => clubCoinBalanceAfterReversal(3, 0)).toThrow(/positive award amount/);
  });

  it('credits bounded live intervals, ignores long gaps, and requires five eligible minutes', () => {
    const lastHeartbeatAt = new Date('2026-10-26T12:00:00.000Z');
    const current = { eligibleDurationSeconds: 240, lastHeartbeatAt };
    expect(creditLiveAttendance(current, new Date(lastHeartbeatAt.getTime() + 30_000))).toEqual({ eligibleDurationSeconds: 270, creditedSeconds: 30 });
    expect(creditLiveAttendance(current, new Date(lastHeartbeatAt.getTime() + 5 * 60_000))).toEqual({ eligibleDurationSeconds: 240, creditedSeconds: 0 });
    expect(creditLiveAttendance(current, new Date(lastHeartbeatAt.getTime() + 90_000))).toEqual({ eligibleDurationSeconds: 285, creditedSeconds: 45 });
    expect(LIVE_ATTENDANCE_REWARD_THRESHOLD_SECONDS).toBe(300);
  });
});
