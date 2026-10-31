import { contentBlockSchema, safeExternalUrl } from './content-validation.js';
import { env } from './config.js';
import type { z } from 'zod';

type Block = z.infer<typeof contentBlockSchema>;
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderBlocks(raw: unknown) {
  const blocks = raw as Block[];
  return blocks.map(block => {
    if (block.type === 'heading') return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}${block.linkUrl ? ` <a href="${escapeHtml(safeExternalUrl(block.linkUrl))}" rel="nofollow noopener">Read more</a>` : ''}</p>`;
    if (block.type === 'quote') return `<blockquote><p>${escapeHtml(block.text)}</p>${block.cite ? `<cite>${escapeHtml(block.cite)}</cite>` : ''}</blockquote>`;
    if (block.type === 'list') { const tag = block.ordered ? 'ol' : 'ul'; return `<${tag}>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`; }
    if (block.type === 'image') return `<figure><img src="/content-media/${encodeURIComponent(block.mediaId)}" alt="${escapeHtml(block.alt)}" loading="lazy"></figure>`;
    if (block.type === 'video') return `<figure><video controls preload="metadata" aria-label="${escapeHtml(block.title ?? 'Video')}"><source src="/content-media/${encodeURIComponent(block.mediaId)}">${block.captionMediaId ? `<track kind="captions" src="/content-media/${encodeURIComponent(block.captionMediaId)}">` : ''}</video>${block.title ? `<figcaption>${escapeHtml(block.title)}</figcaption>` : ''}</figure>`;
    return `<p><a href="/content-media/${encodeURIComponent(block.mediaId)}" download>${escapeHtml(block.label)}</a></p>`;
  }).join('\n');
}

export function renderDocument(input: { title: string; description: string; canonical: string; body: string; type: 'WebPage' | 'BlogPosting'; publishedAt?: Date | null; updatedAt: Date; noIndex?: boolean; noFollow?: boolean; imageUrl?: string | null; breadcrumb: string; siteName?: string | null; faviconUrl?: string | null; marketplaceAdPlacement?: boolean; chromeHeader?: string; chromeFooter?: string; chromeStylesHref?: string; platformDisclosure?: string }) {
  const robots = `${input.noIndex ? 'noindex' : 'index'},${input.noFollow ? 'nofollow' : 'follow'}`;
  const structured = input.type === 'BlogPosting' ? { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: input.title, description: input.description, url: input.canonical, datePublished: input.publishedAt?.toISOString(), dateModified: input.updatedAt.toISOString(), image: input.imageUrl ? `${env.SITE_URL}${input.imageUrl}` : undefined } : { '@context': 'https://schema.org', '@type': 'WebPage', name: input.title, description: input.description, url: input.canonical, dateModified: input.updatedAt.toISOString() };
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: env.SITE_URL }, { '@type': 'ListItem', position: 2, name: input.breadcrumb, item: input.canonical }] };
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  const documentTitle = input.siteName ? `${input.title} | ${input.siteName}` : input.title;
  const adSlot = input.marketplaceAdPlacement ? '<aside class="marketplace-ad-blog-slot" data-marketplace-ad-placement="BLOG_POSTS" aria-label="Sponsored marketplace products" hidden><h2>Sponsored marketplace products</h2></aside>' : '';
  const adAssets = input.marketplaceAdPlacement ? '<link rel="stylesheet" href="/api/marketplace-ads/placement.css"><script src="/api/marketplace-ads/blog-placement.js" defer></script>' : '';
  const chromeStyles = input.chromeStylesHref ? `<link rel="stylesheet" href="${escapeHtml(input.chromeStylesHref)}">` : '';
  const disclosure = input.platformDisclosure ? `<p class="siteChromeSsrDisclosure">${escapeHtml(input.platformDisclosure)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(documentTitle)}</title><meta name="description" content="${escapeHtml(input.description)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${escapeHtml(input.canonical)}"><meta property="og:type" content="${input.type === 'BlogPosting' ? 'article' : 'website'}"><meta property="og:title" content="${escapeHtml(input.title)}"><meta property="og:description" content="${escapeHtml(input.description)}">${input.siteName ? `<meta property="og:site_name" content="${escapeHtml(input.siteName)}">` : ''}${input.imageUrl ? `<meta property="og:image" content="${escapeHtml(`${env.SITE_URL}${input.imageUrl}`)}">` : ''}${input.faviconUrl ? `<link rel="icon" href="${escapeHtml(input.faviconUrl)}">` : ''}${chromeStyles}${adAssets}<script type="application/ld+json">${json(structured)}</script><script type="application/ld+json">${json(breadcrumb)}</script></head><body id="top">${input.chromeHeader ?? ''}<main><article><h1>${escapeHtml(input.title)}</h1>${input.publishedAt ? `<time datetime="${input.publishedAt.toISOString()}">${input.publishedAt.toISOString().slice(0, 10)}</time>` : ''}${input.body}${adSlot}</article></main>${input.chromeFooter ?? ''}${disclosure}</body></html>`;
}
