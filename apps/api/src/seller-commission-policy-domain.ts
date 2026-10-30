import { isFreePlan, type PlanPricingRecord } from './store-plan-pricing.js';

/** Commission rules apply only to ordinary Stores on a free plan. The platform Store and every paid plan are exempt. */
export function freeStoreCommissionApplies(isPlatformStore: boolean, pricing: PlanPricingRecord | null | undefined) {
  return !isPlatformStore && Boolean(pricing && isFreePlan(pricing));
}
