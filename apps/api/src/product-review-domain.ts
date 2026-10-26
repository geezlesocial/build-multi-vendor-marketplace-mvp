export type ProductReviewEligibility = {
  emailVerified: boolean;
  paidReceivedPurchase: boolean;
  alreadySubmitted: boolean;
};

export function productReviewEligibility(input: ProductReviewEligibility) {
  if (!input.emailVerified) return { eligible: false, reason: 'Verify your email address before submitting a review.' };
  if (input.alreadySubmitted) return { eligible: false, reason: 'You have already submitted a review for this product.' };
  if (!input.paidReceivedPurchase) return { eligible: false, reason: 'Reviews are available after a paid order is marked received.' };
  return { eligible: true, reason: '' };
}
