import { describe, expect, it } from 'vitest';
import { productReviewEligibility } from './product-review-domain.js';

describe('verified product-review eligibility', () => {
  it('requires email verification, a paid received purchase, and a new review', () => {
    expect(productReviewEligibility({ emailVerified: false, paidReceivedPurchase: true, alreadySubmitted: false })).toEqual({ eligible: false, reason: 'Verify your email address before submitting a review.' });
    expect(productReviewEligibility({ emailVerified: true, paidReceivedPurchase: false, alreadySubmitted: false }).eligible).toBe(false);
    expect(productReviewEligibility({ emailVerified: true, paidReceivedPurchase: true, alreadySubmitted: true }).eligible).toBe(false);
    expect(productReviewEligibility({ emailVerified: true, paidReceivedPurchase: true, alreadySubmitted: false })).toEqual({ eligible: true, reason: '' });
  });
});
