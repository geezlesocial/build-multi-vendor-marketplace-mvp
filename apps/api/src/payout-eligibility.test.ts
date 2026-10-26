import { describe, expect, it } from 'vitest';
import { payoutEligibilityFailure, remainingSaleMinor } from './payout-eligibility.js';

const receivedAt = new Date('2026-10-20T00:00:00.000Z');
const now = new Date('2026-10-25T00:00:00.000Z');
const eligibleOrder = { receivedAt, status: 'FULFILLED', payment: { status: 'PAID', method: 'STRIPE' } };

describe('buyer receipt payout eligibility', () => {
  it('allows paid online proceeds only after buyer receipt and the configured hold', () => {
    expect(payoutEligibilityFailure(eligibleOrder, 3, now)).toBeNull();
  });

  it('holds proceeds until the buyer confirms receipt', () => {
    expect(payoutEligibilityFailure({ ...eligibleOrder, receivedAt: null }, 0, now)).toMatch(/receipt is not confirmed/);
  });

  it('waits until the full post-receipt hold has elapsed', () => {
    expect(payoutEligibilityFailure(eligibleOrder, 6, now)).toMatch(/hold has not elapsed/);
  });

  it.each(['COD', 'POS'])('excludes %s from the platform-held payout gate', method => {
    expect(payoutEligibilityFailure({ ...eligibleOrder, payment: { status: 'PAID', method } }, 0, now)).toMatch(/online payment/);
  });

  it('rejects cancelled or unpaid orders', () => {
    expect(payoutEligibilityFailure({ ...eligibleOrder, status: 'CANCELLED' }, 0, now)).toMatch(/Cancelled/);
    expect(payoutEligibilityFailure({ ...eligibleOrder, payment: { status: 'PENDING', method: 'STRIPE' } }, 0, now)).toMatch(/online payment/);
  });

  it('blocks unresolved provider adjustment reviews and subtracts posted item refunds', () => {
    expect(payoutEligibilityFailure({ ...eligibleOrder, refundReviewPending: true }, 0, now)).toMatch(/awaiting reconciliation/);
    expect(remainingSaleMinor(2400, 600)).toBe(1800);
    expect(remainingSaleMinor(2400, 3000)).toBe(0);
  });
});
