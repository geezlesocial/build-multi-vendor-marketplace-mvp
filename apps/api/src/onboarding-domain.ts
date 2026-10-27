import { z } from 'zod';

export const referralSourceValues = ['FRIEND', 'GOOGLE', 'FACEBOOK', 'TWITTER_X', 'LINKEDIN', 'SCROLITH', 'AI_RECOMMENDATION', 'OTHER'] as const;

export const referralSourceOptions = [
  { value: 'FRIEND', label: 'Introduced by a Friend' },
  { value: 'GOOGLE', label: 'Google' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'TWITTER_X', label: 'Twitter / X' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
  { value: 'SCROLITH', label: 'Scrolith' },
  { value: 'AI_RECOMMENDATION', label: 'AI Recommendation' },
  { value: 'OTHER', label: 'Others' }
] as const;

export const onboardingCompletionSchema = z.object({
  displayCurrency: z.string().trim().length(3).transform(value => value.toUpperCase()),
  referralSource: z.enum(referralSourceValues),
  referralOther: z.string().trim().max(120).refine(value => !/[<>]/.test(value), 'Use plain text without HTML tags.').optional().transform(value => value || undefined)
}).strict().superRefine((value, context) => {
  if (value.referralSource !== 'OTHER' && value.referralOther) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['referralOther'], message: 'Only provide a clarification when the referral source is Others.' });
  }
});

export function onboardingCompletionBlock(input: { eligibleFollowCount: number; currencyAvailable: boolean }) {
  if (input.eligibleFollowCount < 2) return { code: 'ONBOARDING_STORES_REQUIRED', message: 'Follow at least two currently eligible stores before completing onboarding.' };
  if (!input.currencyAvailable) return { code: 'ONBOARDING_CURRENCY_UNAVAILABLE', message: 'Choose a currency currently enabled for marketplace display.' };
  return null;
}
