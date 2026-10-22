import { StorePlanBillingInterval, StorePlanCancellationPolicy, StorePlanExpirationBehavior } from '@prisma/client';
import { z } from 'zod';

// Restrict pricing to currencies whose minor unit has two decimal places in this MVP.
export const supportedPlanCurrencies = ['AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'SGD', 'USD'] as const;
export const MAX_PLAN_PRICE_MINOR = 2_000_000_000;

const amountText = z.string().trim().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/, 'Enter a non-negative amount with at most two decimal places');
const dateText = z.string().datetime({ offset: true });

export const planPricingInputSchema = z.object({
  description: z.string().trim().max(2000).default(''),
  currency: z.enum(supportedPlanCurrencies).default('USD'),
  monthlyPrice: amountText.default('0'),
  annualPriceMode: z.enum(['FULL', 'FIXED', 'DISCOUNT']).default('FULL'),
  annualPrice: amountText.optional(),
  annualDiscountPercent: z.number().int().min(1).max(90).optional(),
  defaultInterval: z.nativeEnum(StorePlanBillingInterval).default(StorePlanBillingInterval.MONTHLY),
  termIntervals: z.number().int().min(1).max(120).nullable().default(null),
  expirationBehavior: z.nativeEnum(StorePlanExpirationBehavior).default(StorePlanExpirationBehavior.DOWNGRADE_TO_LEGACY),
  cancellationPolicy: z.nativeEnum(StorePlanCancellationPolicy).default(StorePlanCancellationPolicy.CANCEL_ANYTIME),
  freeTrialDays: z.number().int().min(0).max(90).default(0),
  introPrice: amountText.optional(),
  introDurationDays: z.number().int().min(1).max(365).optional(),
  effectiveFrom: dateText.optional(),
  effectiveUntil: dateText.optional()
}).strict().superRefine((input, ctx) => {
  if (input.annualPriceMode === 'FIXED' && input.annualPrice === undefined) ctx.addIssue({ code: 'custom', path: ['annualPrice'], message: 'Enter an annual amount for fixed annual pricing' });
  if (input.annualPriceMode !== 'FIXED' && input.annualPrice !== undefined) ctx.addIssue({ code: 'custom', path: ['annualPrice'], message: 'Annual amount is only used for fixed annual pricing' });
  if (input.annualPriceMode === 'DISCOUNT' && input.annualDiscountPercent === undefined) ctx.addIssue({ code: 'custom', path: ['annualDiscountPercent'], message: 'Enter an annual discount percentage' });
  if (input.annualPriceMode !== 'DISCOUNT' && input.annualDiscountPercent !== undefined) ctx.addIssue({ code: 'custom', path: ['annualDiscountPercent'], message: 'Discount percentage is only used for discounted annual pricing' });
  if ((input.introPrice === undefined) !== (input.introDurationDays === undefined)) ctx.addIssue({ code: 'custom', path: ['introPrice'], message: 'A paid introductory amount and duration must be supplied together' });
  if (input.effectiveFrom && input.effectiveUntil && Date.parse(input.effectiveUntil) <= Date.parse(input.effectiveFrom)) ctx.addIssue({ code: 'custom', path: ['effectiveUntil'], message: 'The end date must be after the start date' });
});

export type PlanPricingInput = z.infer<typeof planPricingInputSchema>;
export type PlanPricingRecord = {
  description: string;
  currency: string;
  monthlyPriceMinor: number;
  annualPriceMinor: number;
  annualDiscountPercent: number | null;
  defaultInterval: StorePlanBillingInterval;
  termIntervals: number | null;
  expirationBehavior: StorePlanExpirationBehavior;
  cancellationPolicy: StorePlanCancellationPolicy;
  freeTrialDays: number;
  introPriceMinor: number | null;
  introDurationDays: number | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export function parseMinorAmount(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error('Invalid amount');
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const minor = whole * 100n + fraction;
  if (minor > BigInt(MAX_PLAN_PRICE_MINOR)) throw new Error('Amount exceeds the supported maximum');
  return Number(minor);
}

export function formatMinorAmount(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Invalid minor-unit amount');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function annualPriceFromDiscount(monthlyMinor: number, percent: number): number {
  if (!Number.isSafeInteger(monthlyMinor) || monthlyMinor < 0 || !Number.isInteger(percent) || percent < 1 || percent > 90) throw new Error('Invalid annual discount inputs');
  const annualBeforeDiscount = BigInt(monthlyMinor) * 12n;
  const result = (annualBeforeDiscount * BigInt(100 - percent) + 50n) / 100n;
  if (result > BigInt(MAX_PLAN_PRICE_MINOR)) throw new Error('Annual amount exceeds the supported maximum');
  return Number(result);
}

export function resolvePlanPricing(input: PlanPricingInput): PlanPricingRecord {
  const monthlyPriceMinor = parseMinorAmount(input.monthlyPrice);
  const fullAnnual = BigInt(monthlyPriceMinor) * 12n;
  if (fullAnnual > BigInt(MAX_PLAN_PRICE_MINOR)) throw new Error('Annual amount exceeds the supported maximum');
  let annualPriceMinor = Number(fullAnnual);
  let annualDiscountPercent: number | null = null;
  if (input.annualPriceMode === 'FIXED') {
    annualPriceMinor = parseMinorAmount(input.annualPrice!);
    if (annualPriceMinor > Number(fullAnnual)) throw new Error('Annual price cannot exceed twelve monthly payments');
    if (monthlyPriceMinor > 0 && annualPriceMinor === 0) throw new Error('A paid plan cannot have a zero-priced annual interval');
  } else if (input.annualPriceMode === 'DISCOUNT') {
    if (monthlyPriceMinor === 0) throw new Error('A free plan cannot have an annual discount');
    annualDiscountPercent = input.annualDiscountPercent!;
    annualPriceMinor = annualPriceFromDiscount(monthlyPriceMinor, annualDiscountPercent);
  }
  const introPriceMinor = input.introPrice === undefined ? null : parseMinorAmount(input.introPrice);
  if (introPriceMinor !== null) {
    if (introPriceMinor === 0) throw new Error('An introductory offer must be paid; use the separate free-trial setting for a free period');
    if (monthlyPriceMinor === 0 || introPriceMinor >= monthlyPriceMinor) throw new Error('The paid introductory amount must be below the normal monthly price');
  }
  if (input.freeTrialDays > 0 && monthlyPriceMinor === 0) throw new Error('A free trial requires a paid recurring plan');
  return {
    description: input.description,
    currency: input.currency,
    monthlyPriceMinor,
    annualPriceMinor,
    annualDiscountPercent,
    defaultInterval: input.defaultInterval,
    termIntervals: input.termIntervals,
    expirationBehavior: input.expirationBehavior,
    cancellationPolicy: input.cancellationPolicy,
    freeTrialDays: input.freeTrialDays,
    introPriceMinor,
    introDurationDays: input.introDurationDays ?? null,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
    effectiveUntil: input.effectiveUntil ? new Date(input.effectiveUntil) : null
  };
}

export function isFreePlan(pricing: Pick<PlanPricingRecord, 'monthlyPriceMinor' | 'annualPriceMinor' | 'introPriceMinor' | 'freeTrialDays'>) {
  return pricing.monthlyPriceMinor === 0 && pricing.annualPriceMinor === 0 && pricing.introPriceMinor === null && pricing.freeTrialDays === 0;
}

export type SubscriptionStatus = 'PENDING' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'UNPAID';
const subscriptionTransitions: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  PENDING: ['TRIALING', 'ACTIVE', 'CANCELLED', 'UNPAID'],
  TRIALING: ['ACTIVE', 'CANCELLED', 'EXPIRED', 'PAST_DUE'],
  ACTIVE: ['PAST_DUE', 'CANCELLED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'UNPAID', 'CANCELLED', 'EXPIRED'],
  CANCELLED: [],
  EXPIRED: [],
  UNPAID: ['ACTIVE', 'CANCELLED', 'EXPIRED']
};

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus) {
  return subscriptionTransitions[from].includes(to);
}
