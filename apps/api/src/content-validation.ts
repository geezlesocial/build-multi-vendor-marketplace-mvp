import { z } from 'zod';
import { Prisma } from '@prisma/client';

const id = z.string().min(1).max(80);
const plainText = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[<>]/.test(value), 'HTML is not accepted in structured content');
const safeLinkUrl = z.string().url().max(2000).refine(value => {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'Only HTTP(S) and mailto links are allowed');

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3), z.literal(4)]), text: plainText(500) }),
  z.object({ type: z.literal('paragraph'), text: plainText(5000), linkUrl: safeLinkUrl.optional() }),
  z.object({ type: z.literal('quote'), text: plainText(3000), cite: plainText(200).optional() }),
  z.object({ type: z.literal('list'), ordered: z.boolean().default(false), items: z.array(plainText(500)).min(1).max(50) }),
  z.object({ type: z.literal('image'), mediaId: id, alt: plainText(300) }),
  z.object({ type: z.literal('video'), mediaId: id, captionMediaId: id.optional(), title: plainText(300).optional() }),
  z.object({ type: z.literal('file'), mediaId: id, label: plainText(300) })
]);

export const contentBodySchema = z.array(contentBlockSchema).max(200);
export const contentSlugSchema = z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and hyphens');
const canonicalUrlSchema = z.string().url().max(2000).refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Canonical URL must use HTTP(S)');
export const contentWriteSchema = z.object({
  title: plainText(160),
  slug: contentSlugSchema,
  excerpt: z.string().trim().max(500).optional(),
  body: contentBodySchema.transform(value => value as unknown as Prisma.InputJsonValue),
  seoTitle: plainText(160).optional(),
  seoDescription: plainText(320).optional(),
  canonicalUrl: canonicalUrlSchema.optional(),
  noIndex: z.boolean().default(false),
  noFollow: z.boolean().default(false),
  scheduledAt: z.string().datetime().optional(),
  categoryId: id.optional(),
  tags: z.array(z.object({ name: plainText(80), slug: contentSlugSchema })).max(30).default([]),
  featuredImageId: id.optional(),
  ogImageId: id.optional(),
  changeNote: z.string().trim().max(500).optional()
});

export const pageWriteSchema = contentWriteSchema.extend({
  pageType: z.enum(['STANDARD', 'ABOUT', 'TERMS', 'PRIVACY', 'POLICY', 'HELP', 'LANDING']).default('STANDARD'),
  parentId: id.optional(),
  navPlacement: z.enum(['NONE', 'HEADER', 'FOOTER', 'BOTH']).default('NONE'),
  navLabel: plainText(120).optional(),
  navOrder: z.number().int().min(0).max(10000).default(0)
});

export const contentActionSchema = z.object({ action: z.enum(['publish', 'schedule', 'unpublish', 'archive', 'restore']), scheduledAt: z.string().datetime().optional(), reason: z.string().trim().max(500).optional() });

export function slugPath(kind: 'blog' | 'pages', slug: string) { return `/${kind}/${slug}`; }

export function safeExternalUrl(value: string) {
  const parsed = new URL(value);
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) and mailto links are allowed');
  return parsed.toString();
}

export function mediaExtension(filename: string) {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return extension.replace(/[^a-z0-9]/g, '').slice(0, 8);
}

export function mediaKindFor(mime: string, filename: string) {
  if (mime.startsWith('image/')) return 'IMAGE' as const;
  if (mime.startsWith('video/')) return 'VIDEO' as const;
  if (mime === 'text/vtt' || filename.toLowerCase().endsWith('.vtt')) return 'CAPTION' as const;
  return 'DOCUMENT' as const;
}
