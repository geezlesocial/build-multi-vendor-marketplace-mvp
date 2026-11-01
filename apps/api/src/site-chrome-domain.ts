import { StoreSubscriptionStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './security.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hexadecimal color');
const safeHref = z.string().trim().min(1).max(1000).refine(value => {
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, 'Use a safe internal path or HTTPS link');

const linkSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(48),
  href: safeHref,
  enabled: z.boolean().default(true)
}).strict();

const sectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  title: z.string().trim().min(1).max(60),
  links: z.array(linkSchema).max(10).default([])
}).strict();

const socialSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  platform: z.enum(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'PINTEREST', 'WEBSITE', 'OTHER']),
  url: z.string().trim().url().max(1000).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }, 'Social links must use HTTPS'),
  label: z.string().trim().max(48).default(''),
  iconMediaId: z.string().min(1).max(80).nullable().default(null),
  enabled: z.boolean().default(true),
  display: z.enum(['ICON_AND_LABEL', 'ICON_ONLY']).default('ICON_AND_LABEL')
}).strict();

const headerSchema = z.object({
    template: z.enum(['CLASSIC', 'EDITORIAL', 'COMMERCE']).default('CLASSIC'),
    title: z.string().trim().max(80).default(''),
    tagline: z.string().trim().max(140).default(''),
    logoMediaId: z.string().min(1).max(80).nullable().default(null),
    backgroundColor: hexColor.default('#f5f5f0'),
    textColor: hexColor.default('#18211d'),
    accentColor: hexColor.default('#325a45'),
    alignment: z.enum(['LEFT', 'CENTER']).default('LEFT'),
    sticky: z.boolean().default(true),
    showSearch: z.boolean().default(false),
    showCategoryLinks: z.boolean().default(false),
    density: z.enum(['COMPACT', 'STANDARD', 'SPACIOUS']).default('STANDARD'),
    ctaLinkId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().default(null),
    announcementEnabled: z.boolean().default(false),
    announcementText: z.string().trim().max(180).default(''),
    announcementHref: safeHref.nullable().default(null),
    navigation: z.array(linkSchema).max(8).default([])
  }).strict();

const footerSchema = z.object({
    template: z.enum(['MINIMAL', 'BUSINESS', 'SIGNATURE']).default('MINIMAL'),
    title: z.string().trim().max(80).default(''),
    description: z.string().trim().max(500).default(''),
    logoMediaId: z.string().min(1).max(80).nullable().default(null),
    logoWidth: z.number().int().min(24).max(240).default(72),
    logoHeight: z.number().int().min(16).max(96).default(48),
    backgroundColor: hexColor.default('#edf3ed'),
    textColor: hexColor.default('#26342c'),
    accentColor: hexColor.default('#325a45'),
    alignment: z.enum(['LEFT', 'CENTER']).default('LEFT'),
    sections: z.array(sectionSchema).max(4).default([]),
    socials: z.array(socialSchema).max(6).default([]),
    contactEmail: z.string().trim().email().max(320).nullable().default(null),
    contactPhone: z.string().trim().max(40).nullable().default(null),
    copyright: z.string().trim().max(180).default(''),
    backToTop: z.boolean().default(false)
  }).strict();

export const siteChromeSchema = z.object({
  header: headerSchema.default(() => headerSchema.parse({})),
  footer: footerSchema.default(() => footerSchema.parse({})),
  suppressedPageKeys: z.array(z.string().min(1).max(100)).max(150).default([])
}).strict().superRefine((configuration, context) => {
  const navigationIds = configuration.header.navigation.map(link => link.id);
  if (new Set(navigationIds).size !== navigationIds.length) context.addIssue({ code: 'custom', path: ['header', 'navigation'], message: 'Navigation item IDs must be unique.' });
  if (configuration.header.ctaLinkId && !configuration.header.navigation.some(link => link.id === configuration.header.ctaLinkId && link.enabled)) context.addIssue({ code: 'custom', path: ['header', 'ctaLinkId'], message: 'Choose an enabled navigation link for the header call to action.' });
  const sectionIds = configuration.footer.sections.map(section => section.id);
  if (new Set(sectionIds).size !== sectionIds.length) context.addIssue({ code: 'custom', path: ['footer', 'sections'], message: 'Footer section IDs must be unique.' });
  const socialIds = configuration.footer.socials.map(social => social.id);
  if (new Set(socialIds).size !== socialIds.length) context.addIssue({ code: 'custom', path: ['footer', 'socials'], message: 'Social account IDs must be unique.' });
  const socialUrls = configuration.footer.socials.map(social => social.url.toLowerCase());
  if (new Set(socialUrls).size !== socialUrls.length) context.addIssue({ code: 'custom', path: ['footer', 'socials'], message: 'Social account URLs must be unique.' });
  const suppressionKeys = configuration.suppressedPageKeys;
  if (new Set(suppressionKeys).size !== suppressionKeys.length) context.addIssue({ code: 'custom', path: ['suppressedPageKeys'], message: 'A page can only be selected once.' });
});

export type SiteChromeConfiguration = z.infer<typeof siteChromeSchema>;

export function defaultSiteChrome(): SiteChromeConfiguration {
  return siteChromeSchema.parse({});
}

type ChromeDb = typeof prisma;

export function paidChromeSnapshotIsEligible(input: {
  approvedSeller: boolean;
  platformStore: boolean;
  assignment: { status: string; source: string; planVersionId: string; effectiveFrom: Date; effectiveUntil: Date | null } | null;
  subscription: { provider: string | null; providerSubscriptionId: string | null; status: string; planVersionId: string; interval: string; monthlyPriceMinor: number; annualPriceMinor: number | null; currentPeriodEnd: Date | null; expiresAt: Date | null } | null;
}, now = new Date()) {
  const { assignment, subscription } = input;
  return input.approvedSeller && !input.platformStore && Boolean(assignment && subscription &&
    assignment.status === 'ACTIVE' && assignment.source === 'SUBSCRIPTION' && assignment.effectiveFrom <= now &&
    (!assignment.effectiveUntil || assignment.effectiveUntil > now) && assignment.planVersionId === subscription.planVersionId &&
    subscription.status === StoreSubscriptionStatus.ACTIVE && Boolean(subscription.provider && subscription.providerSubscriptionId?.trim()) && (subscription.interval === 'ANNUAL' ? subscription.annualPriceMinor ?? 0 : subscription.monthlyPriceMinor) > 0 &&
    (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now) && (!subscription.expiresAt || subscription.expiresAt > now));
}

/** Premium site chrome requires an approved Store plus a live, paid, provider-verified subscription assignment.
 * Free/legacy and trial subscriptions deliberately do not qualify. The official marketplace Store is handled by admins. */
export async function paidStoreChromeAccess(db: ChromeDb, storeId: string, now = new Date()) {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { isPlatformStore: true, seller: { select: { status: true } } } });
  if (!store) return false;
  const assignment = await db.storePlanAssignment.findFirst({
    where: {
      storeId,
      status: 'ACTIVE',
      source: 'SUBSCRIPTION',
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }]
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { status: true, source: true, planVersionId: true, effectiveFrom: true, effectiveUntil: true }
  });
  if (!assignment) return false;
  const subscription = await db.storeSubscription.findFirst({
    where: {
      storeId,
      planVersionId: assignment.planVersionId,
      provider: { not: null },
      providerSubscriptionId: { not: null },
      status: StoreSubscriptionStatus.ACTIVE,
      AND: [
        { OR: [{ interval: 'MONTHLY', monthlyPriceMinor: { gt: 0 } }, { interval: 'ANNUAL', annualPriceMinor: { gt: 0 } }] },
        { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
      ]
    },
    select: { provider: true, providerSubscriptionId: true, planVersionId: true, status: true, interval: true, monthlyPriceMinor: true, annualPriceMinor: true, currentPeriodEnd: true, expiresAt: true }
  });
  return paidChromeSnapshotIsEligible({ approvedSeller: store.seller.status === 'APPROVED', platformStore: store.isPlatformStore, assignment, subscription }, now);
}

export function storeChromeConfigurationId(storeId: string) { return `store:${storeId}`; }

export const platformChromePageKeys = new Set(['PLATFORM_HOME', 'PLATFORM_SHOP', 'PLATFORM_FAVORITES', 'PLATFORM_DASHBOARD', 'PLATFORM_BLOG_INDEX', 'PLATFORM_PRODUCT', 'PLATFORM_CATEGORY']);
export const storeChromePageKeys = new Set(['STORE_HOME', 'STORE_PRODUCT']);

export function platformContentPageKey(kind: 'PAGE' | 'POST', id: string) { return `PLATFORM_${kind}:${id}`; }
export function storeContentPageKey(kind: 'PAGE' | 'POST', id: string) { return `STORE_${kind}:${id}`; }

export async function resolvePublishedSiteChrome(input: { storeId?: string; pageKey?: string }) {
  if (input.storeId && !await paidStoreChromeAccess(prisma, input.storeId)) return { configuration: null, publishedVersion: null, footerSuppressed: false };
  const id = input.storeId ? storeChromeConfigurationId(input.storeId) : 'platform';
  const record = await prisma.siteChromeConfiguration.findUnique({ where: { id }, select: { publishedJson: true, publishedVersion: true } });
  if (!record?.publishedJson) return { configuration: null, publishedVersion: null, footerSuppressed: false };
  const parsed = siteChromeSchema.safeParse(record.publishedJson);
  if (!parsed.success) return { configuration: null, publishedVersion: null, footerSuppressed: false };
  return { configuration: parsed.data, publishedVersion: record.publishedVersion, footerSuppressed: Boolean(input.pageKey && parsed.data.suppressedPageKeys.includes(input.pageKey)) };
}
