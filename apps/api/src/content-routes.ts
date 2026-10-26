import crypto from 'node:crypto';
import path from 'node:path';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { ContentStatus, MediaKind, MediaPurpose, MediaScanStatus, MediaUploadStatus, Role, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { contentActionSchema, contentWriteSchema, mediaExtension, pageWriteSchema, slugPath } from './content-validation.js';
import { objectContentStorage, openContentObject } from './content-storage.js';
import type { ManagedContentStorage } from './content-storage.js';
import { detectStoreMedia } from './store-media-routes.js';
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from './media-scanner.js';
import { renderBlocks, renderDocument } from './content-renderer.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const contentRoles = [Role.ADMIN, Role.CONTENT_EDITOR];
const adminOnly = [Role.ADMIN];
const now = () => new Date();
function publishedWhere(): Prisma.BlogPostWhereInput {
  return { storeId: null, status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] };
}

function pagePublishedWhere(): Prisma.ContentPageWhereInput {
  return { storeId: null, status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] };
}
const reservedSlugs = new Set(['api', 'admin', 'blog', 'pages', 'content-media', 'content-preview', 'health', 'ready', 'robots.txt', 'sitemap.xml']);
const contentUploadTypes: Record<string, { kind: MediaKind; extensions: string[] }> = {
  'image/png': { kind: MediaKind.IMAGE, extensions: ['png'] }, 'image/jpeg': { kind: MediaKind.IMAGE, extensions: ['jpg', 'jpeg'] },
  'image/webp': { kind: MediaKind.IMAGE, extensions: ['webp'] }, 'image/gif': { kind: MediaKind.IMAGE, extensions: ['gif'] },
  'video/mp4': { kind: MediaKind.VIDEO, extensions: ['mp4'] }, 'video/webm': { kind: MediaKind.VIDEO, extensions: ['webm'] },
  'video/ogg': { kind: MediaKind.VIDEO, extensions: ['ogv', 'ogg'] }, 'application/pdf': { kind: MediaKind.DOCUMENT, extensions: ['pdf'] },
  'text/csv': { kind: MediaKind.DOCUMENT, extensions: ['csv'] }, 'text/vtt': { kind: MediaKind.CAPTION, extensions: ['vtt'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: MediaKind.DOCUMENT, extensions: ['docx'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: MediaKind.DOCUMENT, extensions: ['xlsx'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: MediaKind.DOCUMENT, extensions: ['pptx'] }
};
const contentUploadTtlMs = 60 * 60 * 1000;
function mediaLimit(kind: MediaKind) { return kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : kind === MediaKind.VIDEO ? env.CONTENT_MAX_VIDEO_BYTES : env.CONTENT_MAX_DOCUMENT_BYTES; }

function actor(res: Response) { return res.locals.user as { id: string; role: Role }; }
function assertAdmin(res: Response) { if (actor(res).role !== Role.ADMIN) throw fail(403, 'Administrator permission required'); }
function assertAdminOnlyFields(role: Role, raw: unknown, existing?: { noIndex: boolean; noFollow: boolean; navPlacement?: string; navLabel?: string | null; navOrder?: number }) {
  if (role === Role.ADMIN || !raw || typeof raw !== 'object') return;
  const input = raw as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const changed = (key: string, current: unknown, fallback: unknown) => has(key) && input[key] !== (existing ? current : fallback);
  if (changed('noIndex', existing?.noIndex, false) || changed('noFollow', existing?.noFollow, false) ||
    changed('navPlacement', existing?.navPlacement, 'NONE') || changed('navLabel', existing?.navLabel, null) ||
    changed('navOrder', existing?.navOrder, 0)) throw fail(403, 'Administrator permission required for indexing and navigation settings');
}
function safeDescription(title: string, excerpt?: string | null) { return (excerpt || title).replace(/\s+/g, ' ').trim().slice(0, 320); }
function publicUrl(kind: 'blog' | 'pages', slug: string) { return `${env.SITE_URL}${slugPath(kind, slug)}`; }
function contentMediaIds(body: unknown) { return (Array.isArray(body) ? body : []).flatMap((block: { mediaId?: string; captionMediaId?: string }) => [block.mediaId, block.captionMediaId].filter((value): value is string => Boolean(value))); }
function jsonInput(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

async function assertMediaReady(ids: string[], release: boolean) {
  if (!ids.length) return;
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids }, storeId: null, uploadStatus: 'COMPLETE' }, select: { id: true, scanStatus: true } });
  if (assets.length !== new Set(ids).size) throw fail(400, 'One or more media assets do not exist');
  if (assets.some(asset => asset.scanStatus === MediaScanStatus.REJECTED)) throw fail(409, 'Rejected media cannot be used in content. Choose a different file.');
  if (release && assets.some(asset => asset.scanStatus !== MediaScanStatus.APPROVED)) throw fail(409, 'All media must pass scanning before publication');
}

async function nextRevision(model: 'post' | 'page', id: string) {
  if (model === 'post') return (await prisma.blogPostRevision.findFirst({ where: { postId: id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0;
  return (await prisma.contentPageRevision.findFirst({ where: { pageId: id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0;
}

async function assertRedirectSafe(fromPath: string, destinationPath: string) {
  if (fromPath === destinationPath) throw fail(400, 'Redirect cannot target itself');
  const existing = await prisma.slugRedirect.findUnique({ where: { fromPath }, select: { destinationPath: true } });
  if (existing && existing.destinationPath !== destinationPath) throw fail(409, 'A redirect already exists for this path');
  const destinationRedirect = await prisma.slugRedirect.findUnique({ where: { fromPath: destinationPath }, select: { destinationPath: true } });
  if (destinationRedirect) throw fail(400, 'Redirect chains are not allowed');
}

async function publicMediaAsset(id: string) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.scanStatus !== MediaScanStatus.APPROVED) return null;
  if (asset.uploadStatus !== 'COMPLETE') return null;
  const publishedNow = { status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] };
  const [posts, pages, storePosts, storePages, branding, stores, products, productAttachments] = await Promise.all([
    prisma.blogPost.findMany({ where: { ...publishedNow, storeId: null }, select: { bodyJson: true, featuredImageId: true, ogImageId: true } }),
    prisma.contentPage.findMany({ where: { ...publishedNow, storeId: null }, select: { bodyJson: true, ogImageId: true } }),
    prisma.blogPost.findMany({ where: { ...publishedNow, store: { seller: { status: 'APPROVED' } } }, select: { bodyJson: true, featuredImageId: true, ogImageId: true } }),
    prisma.contentPage.findMany({ where: { ...publishedNow, store: { seller: { status: 'APPROVED' } } }, select: { bodyJson: true, ogImageId: true } }),
    prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } }),
    prisma.store.findMany({ where: { seller: { status: 'APPROVED' }, themePublishedJson: { not: Prisma.JsonNull } }, select: { logoMediaId: true, bannerMediaId: true, themePublishedJson: true } }),
    prisma.productImage.findMany({ where: { mediaAssetId: id, product: { status: 'APPROVED', OR: [{ sellerId: null }, { seller: { status: 'APPROVED' } }] } }, select: { id: true } }),
    prisma.productMedia.findMany({ where: { mediaAssetId: id, product: { status: 'APPROVED', OR: [{ sellerId: null }, { seller: { status: 'APPROVED' } }] } }, select: { id: true } })
  ]);
  const referencedInPublishedContent = [...posts, ...storePosts].some(item => item.featuredImageId === id || item.ogImageId === id || JSON.stringify(item.bodyJson).includes(id)) || [...pages, ...storePages].some(item => item.ogImageId === id || JSON.stringify(item.bodyJson).includes(id)) || JSON.stringify(branding?.publishedJson ?? {}).includes(id) || stores.some(item => item.logoMediaId === id || item.bannerMediaId === id || JSON.stringify(item.themePublishedJson).includes(id)) || products.length > 0 || productAttachments.length > 0;
  return referencedInPublishedContent ? asset : null;
}

function fileSignature(bytes: Buffer, extension: string, claimedMime: string) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: MediaKind.IMAGE, mime: 'image/png', extension: 'png' };
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { kind: MediaKind.IMAGE, mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF89a' || bytes.subarray(0, 6).toString('ascii') === 'GIF87a') return { kind: MediaKind.IMAGE, mime: 'image/gif', extension: 'gif' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: MediaKind.IMAGE, mime: 'image/webp', extension: 'webp' };
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return { kind: MediaKind.VIDEO, mime: 'video/mp4', extension: 'mp4' };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: MediaKind.VIDEO, mime: 'video/webm', extension: 'webm' };
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return { kind: MediaKind.VIDEO, mime: 'video/ogg', extension: 'ogv' };
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: MediaKind.DOCUMENT, mime: 'application/pdf', extension: 'pdf' };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && ['docx', 'xlsx', 'pptx'].includes(extension)) return { kind: MediaKind.DOCUMENT, mime: `application/${extension}`, extension };
  if (bytes.subarray(0, 7).toString('utf8').toUpperCase().startsWith('WEBVTT') && (claimedMime === 'text/vtt' || extension === 'vtt')) return { kind: MediaKind.CAPTION, mime: 'text/vtt', extension: 'vtt' };
  if (['csv'].includes(extension) && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(bytes.toString('utf8'))) return { kind: MediaKind.DOCUMENT, mime: 'text/csv', extension };
  throw fail(415, 'File signature or type is not allowed');
}

async function contentHtml(content: { title: string; bodyJson: unknown; excerpt?: string | null; seoTitle?: string | null; seoDescription?: string | null; canonicalUrl?: string | null; noIndex: boolean; noFollow: boolean; publishedAt?: Date | null; updatedAt: Date; slug: string; ogImageId?: string | null }, kind: 'blog' | 'pages', preview = false) {
  const canonical = content.canonicalUrl || publicUrl(kind, content.slug);
  const branding = await prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } });
  const metadata = branding?.publishedJson && typeof branding.publishedJson === 'object' && !Array.isArray(branding.publishedJson) ? branding.publishedJson as { platformName?: unknown; faviconMediaId?: unknown } : {};
  const siteName = typeof metadata.platformName === 'string' ? metadata.platformName : null;
  const faviconUrl = typeof metadata.faviconMediaId === 'string' ? `/content-media/${encodeURIComponent(metadata.faviconMediaId)}` : null;
  return renderDocument({ title: content.seoTitle || content.title, description: content.seoDescription || safeDescription(content.title, content.excerpt), canonical, body: renderBlocks(content.bodyJson), type: kind === 'blog' ? 'BlogPosting' : 'WebPage', publishedAt: content.publishedAt, updatedAt: content.updatedAt, noIndex: preview || content.noIndex, noFollow: preview || content.noFollow, imageUrl: content.ogImageId ? `/content-media/${encodeURIComponent(content.ogImageId)}` : null, breadcrumb: kind === 'blog' ? 'Blog' : 'Pages', siteName, faviconUrl });
}

export function registerContentRoutes(app: Express, openObject: typeof openContentObject = openContentObject, storage: ManagedContentStorage | null = objectContentStorage, scanner: MalwareScanner | null = malwareScanner) {
  app.get('/api/content/blog', run(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 12)));
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const where: Prisma.BlogPostWhereInput = q ? { AND: [publishedWhere(), { OR: [{ title: { contains: q, mode: 'insensitive' } }, { excerpt: { contains: q, mode: 'insensitive' } }] }] } : publishedWhere();
    const [items, total] = await Promise.all([prisma.blogPost.findMany({ where, select: { id: true, slug: true, title: true, excerpt: true, status: true, publishedAt: true, updatedAt: true, seoTitle: true, seoDescription: true, category: true, tags: { include: { tag: true } } }, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.blogPost.count({ where })]);
    res.json({ items, page, pageSize, total });
  }));
  app.get('/api/content/blog/:slug', run(async (req, res) => { const post = await prisma.blogPost.findFirst({ where: { ...publishedWhere(), slug: param(req.params.slug) }, include: { category: true, tags: { include: { tag: true } } } }); if (!post) return res.status(404).json({ error: 'Post not found' }); res.json({ ...post, body: post.bodyJson }); }));
  app.get('/api/content/pages/:slug', run(async (req, res) => { const page = await prisma.contentPage.findFirst({ where: { ...pagePublishedWhere(), slug: param(req.params.slug) } }); if (!page) return res.status(404).json({ error: 'Page not found' }); res.json({ ...page, body: page.bodyJson }); }));
  app.get('/api/content/navigation', run(async (_req, res) => res.json(await prisma.contentPage.findMany({ where: { ...pagePublishedWhere(), navPlacement: { not: 'NONE' } }, select: { slug: true, title: true, navLabel: true, navPlacement: true, navOrder: true }, orderBy: [{ navOrder: 'asc' }, { title: 'asc' }] }))));

  app.get('/sitemap.xml', run(async (_req, res) => {
    const [posts, pages, storePosts, storePages] = await Promise.all([
      prisma.blogPost.findMany({ where: publishedWhere(), select: { slug: true, updatedAt: true, canonicalUrl: true, noIndex: true } }),
      prisma.contentPage.findMany({ where: pagePublishedWhere(), select: { slug: true, updatedAt: true, canonicalUrl: true, noIndex: true } }),
      prisma.blogPost.findMany({ where: { store: { seller: { status: 'APPROVED' } }, status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] }, select: { slug: true, updatedAt: true, noIndex: true, store: { select: { slug: true } } } }),
      prisma.contentPage.findMany({ where: { store: { seller: { status: 'APPROVED' } }, status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] }, select: { slug: true, updatedAt: true, noIndex: true, store: { select: { slug: true } } } })
    ]);
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const urls = [
      ...posts.filter(post => !post.noIndex).map(post => ({ loc: post.canonicalUrl || publicUrl('blog', post.slug), lastmod: post.updatedAt })),
      ...pages.filter(page => !page.noIndex).map(page => ({ loc: page.canonicalUrl || publicUrl('pages', page.slug), lastmod: page.updatedAt })),
      ...storePosts.filter(post => !post.noIndex && post.store).map(post => ({ loc: `${env.SITE_URL}/store/${post.store!.slug}/blog/${post.slug}`, lastmod: post.updatedAt })),
      ...storePages.filter(page => !page.noIndex && page.store).map(page => ({ loc: `${env.SITE_URL}/store/${page.store!.slug}/pages/${page.slug}`, lastmod: page.updatedAt }))
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${escape(url.loc)}</loc><lastmod>${url.lastmod.toISOString()}</lastmod></url>`).join('')}</urlset>`);
  }));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /content-preview/\nSitemap: ${env.SITE_URL}/sitemap.xml\n`));
  app.get('/content-media/:id', run(async (req, res) => { const asset = await publicMediaAsset(param(req.params.id)); if (!asset) return res.status(404).send('Media not found'); res.setHeader('Content-Type', asset.detectedMime); res.setHeader('Content-Disposition', asset.kind === MediaKind.DOCUMENT || asset.kind === MediaKind.CAPTION ? `attachment; filename="${asset.safeName}"` : `inline; filename="${asset.safeName}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); openObject(asset.storageProvider, asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).send('Media not found'); }).pipe(res); }));

  app.get('/blog/:slug', run(async (req, res) => { const slug = param(req.params.slug); const post = await prisma.blogPost.findFirst({ where: { ...publishedWhere(), slug } }); if (post) return res.type('html').send(await contentHtml(post, 'blog')); const redirect = await prisma.slugRedirect.findUnique({ where: { fromPath: `/blog/${slug}` } }); if (redirect) return res.redirect(redirect.statusCode, redirect.destinationPath); res.status(404).type('html').send('<!doctype html><title>Not found</title><h1>Not found</h1>'); }));
  app.get('/pages/:slug', run(async (req, res) => { const slug = param(req.params.slug); const page = await prisma.contentPage.findFirst({ where: { ...pagePublishedWhere(), slug } }); if (page) return res.type('html').send(await contentHtml(page, 'pages')); const redirect = await prisma.slugRedirect.findUnique({ where: { fromPath: `/pages/${slug}` } }); if (redirect) return res.redirect(redirect.statusCode, redirect.destinationPath); res.status(404).type('html').send('<!doctype html><title>Not found</title><h1>Not found</h1>'); }));
  app.get('/content-preview/:token', run(async (req, res) => { const tokenHash = crypto.createHash('sha256').update(param(req.params.token)).digest('hex'); const preview = await prisma.contentPreviewToken.findFirst({ where: { tokenHash, usedAt: null, expiresAt: { gt: now() } }, include: { post: true, page: true } }); if (!preview) return res.status(404).type('html').send('<!doctype html><title>Preview unavailable</title><h1>Preview unavailable</h1>'); const consumed = await prisma.contentPreviewToken.updateMany({ where: { id: preview.id, usedAt: null, expiresAt: { gt: now() } }, data: { usedAt: now() } }); if (consumed.count !== 1) return res.status(404).type('html').send('<!doctype html><title>Preview unavailable</title><h1>Preview unavailable</h1>'); const item = preview.post || preview.page; if (!item) return res.status(404).send('Preview unavailable'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.type('html').send(await contentHtml(item, preview.post ? 'blog' : 'pages', true)); }));

  app.get('/api/admin/content/posts', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''; const items = await prisma.blogPost.findMany({ where: q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : {}, include: { category: true, author: { select: { name: true, email: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 }); res.json(items); }));
  app.get('/api/admin/content/pages', requireAuth, requireRole(...contentRoles), run(async (_req, res) => res.json(await prisma.contentPage.findMany({ include: { parent: { select: { slug: true, title: true } } }, orderBy: [{ navOrder: 'asc' }, { updatedAt: 'desc' }], take: 100 }))));
  app.get('/api/admin/content/posts/:id', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const post = await prisma.blogPost.findUnique({ where: { id: param(req.params.id) }, include: { revisions: { orderBy: { revisionNumber: 'desc' } }, tags: { include: { tag: true } } } }); if (!post) return res.status(404).json({ error: 'Post not found' }); res.json(post); }));
  app.get('/api/admin/content/pages/:id', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const page = await prisma.contentPage.findUnique({ where: { id: param(req.params.id) }, include: { revisions: { orderBy: { revisionNumber: 'desc' } } } }); if (!page) return res.status(404).json({ error: 'Page not found' }); res.json(page); }));

  app.post('/api/admin/content/posts', requireAuth, requireRole(...contentRoles), run(async (req, res) => {
    const user = actor(res);
    assertAdminOnlyFields(user.role, req.body);
    const input = contentWriteSchema.parse(req.body);
    await assertMediaReady(contentMediaIds(input.body), false);
    const admin = user.role === Role.ADMIN;
    const post = await prisma.$transaction(async tx => {
      const created = await tx.blogPost.create({ data: {
        title: input.title, slug: input.slug, excerpt: input.excerpt, bodyJson: jsonInput(input.body), authorId: user.id, editorId: user.id,
        categoryId: input.categoryId, featuredImageId: input.featuredImageId, ogImageId: input.ogImageId, seoTitle: input.seoTitle, seoDescription: input.seoDescription,
        canonicalUrl: input.canonicalUrl, noIndex: admin ? input.noIndex : false, noFollow: admin ? input.noFollow : false,
        tags: { create: input.tags.map(tag => ({ tag: { connectOrCreate: { where: { slug: tag.slug }, create: tag } } })) }
      } });
      await tx.blogPostRevision.create({ data: { postId: created.id, revisionNumber: 1, title: created.title, slug: created.slug, excerpt: created.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } });
      return created;
    });
    await audit(user.id, 'CONTENT_POST_CREATED', 'BlogPost', post.id);
    res.status(201).json(post);
  }));
  app.patch('/api/admin/content/posts/:id', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const user = actor(res); const input = contentWriteSchema.parse(req.body); const existing = await prisma.blogPost.findUnique({ where: { id: param(req.params.id) } }); if (!existing) return res.status(404).json({ error: 'Post not found' }); assertAdminOnlyFields(user.role, req.body, existing); await assertMediaReady(contentMediaIds(input.body), false); if (existing.slug !== input.slug && existing.status === ContentStatus.PUBLISHED) await assertRedirectSafe(slugPath('blog', existing.slug), slugPath('blog', input.slug)); const admin = user.role === Role.ADMIN; const post = await prisma.$transaction(async tx => { const updated = await tx.blogPost.update({ where: { id: existing.id }, data: { title: input.title, slug: input.slug, excerpt: input.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, categoryId: input.categoryId, featuredImageId: input.featuredImageId, ogImageId: input.ogImageId, seoTitle: input.seoTitle, seoDescription: input.seoDescription, canonicalUrl: input.canonicalUrl, noIndex: admin ? input.noIndex : existing.noIndex, noFollow: admin ? input.noFollow : existing.noFollow, ...(input.scheduledAt ? { scheduledAt: new Date(input.scheduledAt) } : {}) } }); const revisionNumber = (await tx.blogPostRevision.findFirst({ where: { postId: existing.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0; await tx.blogPostRevision.create({ data: { postId: existing.id, revisionNumber: revisionNumber + 1, title: updated.title, slug: updated.slug, excerpt: updated.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } }); if (existing.slug !== updated.slug && existing.status === ContentStatus.PUBLISHED) await tx.slugRedirect.create({ data: { fromPath: slugPath('blog', existing.slug), destinationPath: slugPath('blog', updated.slug), createdById: user.id } }); return updated; }); await audit(user.id, 'CONTENT_POST_UPDATED', 'BlogPost', post.id, { slug: post.slug }); res.json(post); }));

  app.post('/api/admin/content/pages', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const user = actor(res); assertAdminOnlyFields(user.role, req.body); const input = pageWriteSchema.parse(req.body); if (reservedSlugs.has(input.slug)) throw fail(400, 'Reserved route slug'); if (input.parentId === input.slug) throw fail(400, 'A page cannot parent itself'); await assertMediaReady(contentMediaIds(input.body), false); const admin = user.role === Role.ADMIN; const page = await prisma.$transaction(async tx => { const created = await tx.contentPage.create({ data: { title: input.title, slug: input.slug, bodyJson: jsonInput(input.body), pageType: input.pageType, parentId: input.parentId, navPlacement: admin ? input.navPlacement : 'NONE', navLabel: admin ? input.navLabel : null, navOrder: admin ? input.navOrder : 0, editorId: user.id, seoTitle: input.seoTitle, seoDescription: input.seoDescription, ogImageId: input.ogImageId, canonicalUrl: input.canonicalUrl, noIndex: admin ? input.noIndex : false, noFollow: admin ? input.noFollow : false } }); await tx.contentPageRevision.create({ data: { pageId: created.id, revisionNumber: 1, slug: created.slug, title: created.title, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } }); return created; }); await audit(user.id, 'CONTENT_PAGE_CREATED', 'ContentPage', page.id); res.status(201).json(page); }));
  app.patch('/api/admin/content/pages/:id', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const user = actor(res); const input = pageWriteSchema.parse(req.body); if (reservedSlugs.has(input.slug)) throw fail(400, 'Reserved route slug'); const existing = await prisma.contentPage.findUnique({ where: { id: param(req.params.id) } }); if (!existing) return res.status(404).json({ error: 'Page not found' }); assertAdminOnlyFields(user.role, req.body, existing); await assertMediaReady(contentMediaIds(input.body), false); if (existing.slug !== input.slug && existing.status === ContentStatus.PUBLISHED) await assertRedirectSafe(slugPath('pages', existing.slug), slugPath('pages', input.slug)); const admin = user.role === Role.ADMIN; const page = await prisma.$transaction(async tx => { const updated = await tx.contentPage.update({ where: { id: existing.id }, data: { title: input.title, slug: input.slug, bodyJson: jsonInput(input.body), pageType: input.pageType, parentId: input.parentId, navPlacement: admin ? input.navPlacement : existing.navPlacement, navLabel: admin ? input.navLabel : existing.navLabel, navOrder: admin ? input.navOrder : existing.navOrder, editorId: user.id, seoTitle: input.seoTitle, seoDescription: input.seoDescription, ogImageId: input.ogImageId, canonicalUrl: input.canonicalUrl, noIndex: admin ? input.noIndex : existing.noIndex, noFollow: admin ? input.noFollow : existing.noFollow } }); const revisionNumber = (await tx.contentPageRevision.findFirst({ where: { pageId: existing.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0; await tx.contentPageRevision.create({ data: { pageId: existing.id, revisionNumber: revisionNumber + 1, slug: updated.slug, title: updated.title, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } }); if (existing.slug !== updated.slug && existing.status === ContentStatus.PUBLISHED) await tx.slugRedirect.create({ data: { fromPath: slugPath('pages', existing.slug), destinationPath: slugPath('pages', updated.slug), createdById: user.id } }); return updated; }); await audit(user.id, 'CONTENT_PAGE_UPDATED', 'ContentPage', page.id, { slug: page.slug }); res.json(page); }));

  const restoreRevision = (kind: 'post' | 'page') => run(async (req, res) => {
    const user = actor(res);
    assertAdmin(res);
    const revisionNumber = Number(param(req.params.revision));
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) throw fail(400, 'Invalid revision number');
    if (kind === 'post') {
      const revision = await prisma.blogPostRevision.findFirst({ where: { postId: param(req.params.id), revisionNumber } });
      const existing = await prisma.blogPost.findUnique({ where: { id: param(req.params.id) } });
      if (!revision || !existing) return res.status(404).json({ error: 'Revision not found' });
      if (existing.status === ContentStatus.PUBLISHED && existing.slug !== revision.slug) await assertRedirectSafe(slugPath('blog', existing.slug), slugPath('blog', revision.slug));
      const updated = await prisma.$transaction(async tx => { const post = await tx.blogPost.update({ where: { id: existing.id }, data: { title: revision.title, slug: revision.slug, excerpt: revision.excerpt, bodyJson: jsonInput(revision.bodyJson), editorId: user.id, ...(existing.slug !== revision.slug && existing.status === ContentStatus.PUBLISHED ? {} : {}) } }); const next = (await tx.blogPostRevision.findFirst({ where: { postId: post.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0; await tx.blogPostRevision.create({ data: { postId: post.id, revisionNumber: next + 1, title: post.title, slug: post.slug, excerpt: post.excerpt, bodyJson: jsonInput(post.bodyJson), editorId: user.id, changeNote: `Restored revision ${revisionNumber}` } }); if (existing.status === ContentStatus.PUBLISHED && existing.slug !== revision.slug) await tx.slugRedirect.create({ data: { fromPath: slugPath('blog', existing.slug), destinationPath: slugPath('blog', revision.slug), createdById: user.id } }); return post; }); await audit(user.id, 'CONTENT_POST_REVISION_RESTORED', 'BlogPost', updated.id, { revisionNumber }); return res.json(updated);
    }
    const revision = await prisma.contentPageRevision.findFirst({ where: { pageId: param(req.params.id), revisionNumber } });
    const existing = await prisma.contentPage.findUnique({ where: { id: param(req.params.id) } });
    if (!revision || !existing) return res.status(404).json({ error: 'Revision not found' });
    if (existing.status === ContentStatus.PUBLISHED && existing.slug !== revision.slug) await assertRedirectSafe(slugPath('pages', existing.slug), slugPath('pages', revision.slug));
    const updated = await prisma.$transaction(async tx => { const page = await tx.contentPage.update({ where: { id: existing.id }, data: { title: revision.title, slug: revision.slug, bodyJson: jsonInput(revision.bodyJson), editorId: user.id } }); const next = (await tx.contentPageRevision.findFirst({ where: { pageId: page.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0; await tx.contentPageRevision.create({ data: { pageId: page.id, revisionNumber: next + 1, title: page.title, slug: page.slug, bodyJson: jsonInput(page.bodyJson), editorId: user.id, changeNote: `Restored revision ${revisionNumber}` } }); if (existing.status === ContentStatus.PUBLISHED && existing.slug !== revision.slug) await tx.slugRedirect.create({ data: { fromPath: slugPath('pages', existing.slug), destinationPath: slugPath('pages', revision.slug), createdById: user.id } }); return page; }); await audit(user.id, 'CONTENT_PAGE_REVISION_RESTORED', 'ContentPage', updated.id, { revisionNumber }); res.json(updated);
  });
  app.post('/api/admin/content/posts/:id/revisions/:revision/restore', requireAuth, requireRole(...adminOnly), restoreRevision('post'));
  app.post('/api/admin/content/pages/:id/revisions/:revision/restore', requireAuth, requireRole(...adminOnly), restoreRevision('page'));

  const actionRoute = (kind: 'post' | 'page') => run(async (req, res) => {
    const user = actor(res);
    const input = contentActionSchema.parse(req.body);
    const record = kind === 'post' ? await prisma.blogPost.findUnique({ where: { id: param(req.params.id) } }) : await prisma.contentPage.findUnique({ where: { id: param(req.params.id) } });
    if (!record) return res.status(404).json({ error: 'Content not found' });
    if (['publish', 'unpublish', 'archive', 'restore'].includes(input.action)) assertAdmin(res);
    if (input.action === 'schedule' && (!input.scheduledAt || new Date(input.scheduledAt) <= now())) throw fail(400, 'A future scheduledAt timestamp is required');
    const content = record as { id: string; bodyJson: unknown; featuredImageId?: string | null; ogImageId?: string | null };
    if (input.action === 'publish' || input.action === 'schedule') await assertMediaReady(contentMediaIds(content.bodyJson).concat([content.featuredImageId, content.ogImageId].filter((value): value is string => Boolean(value))), input.action === 'publish');
    const data: Record<string, unknown> = input.action === 'publish'
      ? { status: ContentStatus.PUBLISHED, publishedAt: now(), scheduledAt: null, archivedAt: null }
      : input.action === 'schedule'
        ? { status: ContentStatus.SCHEDULED, scheduledAt: new Date(input.scheduledAt!) }
        : input.action === 'unpublish'
          ? { status: ContentStatus.DRAFT, scheduledAt: null }
          : input.action === 'archive'
            ? { status: ContentStatus.ARCHIVED, archivedAt: now() }
            : { status: ContentStatus.DRAFT, archivedAt: null };
    const updated = kind === 'post' ? await prisma.blogPost.update({ where: { id: record.id }, data }) : await prisma.contentPage.update({ where: { id: record.id }, data });
    await audit(user.id, `CONTENT_${kind.toUpperCase()}_${input.action.toUpperCase()}`, kind === 'post' ? 'BlogPost' : 'ContentPage', record.id, { reason: input.reason, scheduledAt: input.scheduledAt });
    res.json(updated);
  });
  app.post('/api/admin/content/posts/:id/action', requireAuth, requireRole(...contentRoles), actionRoute('post'));
  app.post('/api/admin/content/pages/:id/action', requireAuth, requireRole(...contentRoles), actionRoute('page'));

  app.post('/api/admin/content/previews', requireAuth, requireRole(...contentRoles), run(async (req, res) => { const user = actor(res); const body = z.object({ postId: z.string().cuid().optional(), pageId: z.string().cuid().optional() }).refine(value => Boolean(value.postId) !== Boolean(value.pageId), 'Provide exactly one postId or pageId').parse(req.body); const token = crypto.randomBytes(32).toString('base64url'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); await prisma.contentPreviewToken.create({ data: { createdBy: { connect: { id: user.id } }, tokenHash, ...(body.postId ? { post: { connect: { id: body.postId } } } : { page: { connect: { id: body.pageId! } } }), expiresAt: new Date(Date.now() + 10 * 60 * 1000) } }); res.status(201).json({ url: `${env.SITE_URL}/content-preview/${token}`, expiresInSeconds: 600 }); }));
  app.get('/api/admin/content/media', requireAuth, requireRole(...contentRoles), run(async (_req, res) => res.json(await prisma.mediaAsset.findMany({ where: { storeId: null }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, originalName: true, safeName: true, kind: true, detectedMime: true, sizeBytes: true, scanStatus: true, scanErrorCode: true, scanAttemptCount: true, scanCompletedAt: true, uploadStatus: true, storageProvider: true, altText: true, caption: true, createdAt: true } }))));
  app.post('/api/admin/content/media/uploads', requireAuth, requireRole(...contentRoles), run(async (req, res) => {
    const user = actor(res);
    const input = z.object({ fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(120), sizeBytes: z.number().int().positive() }).strict().parse(req.body);
    const extension = mediaExtension(input.fileName);
    const type = contentUploadTypes[input.contentType];
    if (!type || !type.extensions.includes(extension)) throw fail(415, 'Choose a supported image, video, caption, or document file with matching content type.');
    if (input.sizeBytes > mediaLimit(type.kind)) throw fail(413, 'File exceeds the configured size limit.');
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. No file was uploaded.');
    const id = crypto.randomUUID();
    const storageKey = `pending/platform/content/${id}`;
    const asset = await prisma.mediaAsset.create({ data: {
      id, storageKey, originalName: input.fileName, safeName: input.fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120),
      kind: type.kind, detectedMime: input.contentType, sizeBytes: input.sizeBytes,
      checksum: crypto.createHash('sha256').update(`pending:${id}`).digest('hex'), uploaderId: user.id,
      purpose: MediaPurpose.PLATFORM_CONTENT, storageProvider: 'OBJECT', uploadStatus: 'PENDING', scanStatus: 'QUARANTINED'
    } });
    try {
      const upload = await storage.createUploadForm(storageKey, input.contentType, input.sizeBytes);
      await audit(user.id, 'CONTENT_MEDIA_UPLOAD_RESERVED', 'MediaAsset', id, { kind: type.kind, sizeBytes: input.sizeBytes });
      return res.status(201).json({ id: asset.id, upload, expiresInSeconds: 300, uploadStatus: asset.uploadStatus, scanStatus: asset.scanStatus, publicAfterUpload: false });
    } catch {
      await prisma.mediaAsset.updateMany({ where: { id, uploaderId: user.id, uploadStatus: 'PENDING' }, data: { uploadStatus: 'FAILED' } });
      throw fail(503, 'A temporary upload authorization could not be issued. Retry safely.');
    }
  }));
  app.post('/api/admin/content/media/:id/finalize', requireAuth, requireRole(...contentRoles), run(async (req, res) => {
    const user = actor(res);
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. The file remains unavailable.');
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), uploaderId: user.id, storeId: null, purpose: MediaPurpose.PLATFORM_CONTENT, storageProvider: 'OBJECT', uploadStatus: { in: ['PENDING', 'COMPLETE'] } } });
    if (!asset) throw fail(404, 'Pending content media upload not found.');
    if (asset.uploadStatus === 'COMPLETE') return res.status(asset.scanStatus === 'APPROVED' ? 200 : 202).json({ id: asset.id, kind: asset.kind, scanStatus: asset.scanStatus, scanErrorCode: asset.scanErrorCode, uploadStatus: asset.uploadStatus, publicAfterUpload: false, message: 'This upload was already finalized. Its saved scan state is unchanged.' });
    if (asset.createdAt < new Date(Date.now() - contentUploadTtlMs)) {
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: 'PENDING' }, data: { uploadStatus: 'FAILED' } });
      await storage.remove(asset.storageKey).catch(() => undefined);
      throw fail(410, 'Upload authorization expired. Choose the file again to retry.');
    }
    const claim = await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: 'PENDING' }, data: { uploadStatus: 'VERIFYING' } });
    if (claim.count !== 1) throw fail(409, 'Upload is already being verified or is no longer available.');
    let finalKey: string | null = null;
    let persisted = false;
    try {
      const limit = mediaLimit(asset.kind);
      const head = await storage.head(asset.storageKey);
      if (head.ContentLength !== asset.sizeBytes || head.ContentLength > limit || head.ContentType !== asset.detectedMime) throw fail(400, 'Uploaded object size or type does not match its reservation.');
      const read = await storage.readLimited(asset.storageKey, limit);
      if (read.bytes.length !== asset.sizeBytes || read.contentLength !== asset.sizeBytes || read.contentType !== asset.detectedMime) throw fail(400, 'Uploaded object metadata does not match its reservation.');
      const extension = mediaExtension(asset.originalName);
      const detected = detectStoreMedia(read.bytes, extension, asset.detectedMime);
      if (detected.kind !== asset.kind) throw fail(415, 'Uploaded file content does not match its reservation.');
      let bytes = read.bytes; let mime = detected.mime; let ext = detected.extension;
      let width: number | undefined; let height: number | undefined;
      if (detected.kind === MediaKind.IMAGE) {
        const decoder = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' });
        const metadata = await decoder.metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw fail(415, 'Image data could not be safely decoded.');
        width = metadata.width; height = metadata.height;
        bytes = await decoder.rotate().webp({ quality: 86 }).toBuffer(); mime = 'image/webp'; ext = 'webp';
      }
      if (bytes.length > limit) throw fail(413, 'Processed file exceeds the configured size limit.');
      finalKey = `platform/content/${asset.id}.${ext}`;
      await storage.put(finalKey, bytes, mime);
      await prisma.$transaction(async tx => {
        const updated = await tx.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: 'VERIFYING' }, data: {
          storageKey: finalKey!, safeName: `${path.parse(asset.safeName).name}.${ext}`, detectedMime: mime, sizeBytes: bytes.length,
          width: width ?? null, height: height ?? null, checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
          purpose: MediaPurpose.PLATFORM_CONTENT, uploadStatus: 'COMPLETE', scanStatus: MediaScanStatus.QUARANTINED,
          scanAttemptId: null, scanStartedAt: null, scanCompletedAt: null, scanErrorCode: null, scannerProvider: null
        } });
        if (updated.count !== 1) throw fail(409, 'Upload is no longer available.');
        await tx.auditLog.create({ data: { actorId: user.id, action: 'CONTENT_MEDIA_QUARANTINED', entity: 'MediaAsset', entityId: asset.id, metadata: { kind: asset.kind, sizeBytes: bytes.length } } });
      });
      persisted = true;
      await storage.remove(asset.storageKey).catch(() => undefined);
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes, scanner, actorId: user.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json({ kind: asset.kind, detectedMime: mime, sizeBytes: bytes.length, ...scan, uploadStatus: 'COMPLETE', publicAfterUpload: false, message: scan.scanStatus === MediaScanStatus.APPROVED ? 'Upload verified and scanned. It can be used in a draft; publication remains an explicit action.' : scan.scanErrorCode === 'MALWARE_DETECTED' ? 'The scanner rejected this file. It remains private and cannot be published.' : 'Upload verified. The file remains private in quarantine until the configured scanner approves it.' });
    } catch (error) {
      if (persisted) return res.status(202).json({ id: asset.id, uploadStatus: 'COMPLETE', scanStatus: MediaScanStatus.QUARANTINED, publicAfterUpload: false, message: 'The file is safely stored in private quarantine, but its scan result could not be confirmed. Retry the scan later.' });
      if (finalKey) await storage.remove(finalKey).catch(() => undefined);
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 503;
      if (status >= 400 && status < 500) {
        await storage.remove(asset.storageKey).catch(() => undefined);
        await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: 'VERIFYING' }, data: { uploadStatus: 'FAILED' } });
        throw error;
      }
      await prisma.mediaAsset.updateMany({ where: { id: asset.id, uploaderId: user.id, uploadStatus: 'VERIFYING' }, data: { uploadStatus: 'PENDING' } });
      throw fail(503, 'The upload could not be safely verified. It remains unavailable; retry later.');
    }
  }));
  app.post('/api/admin/content/media/:id/scan-retry', requireAuth, requireRole(...contentRoles), run(async (req, res) => {
    const user = actor(res);
    const asset = await prisma.mediaAsset.findFirst({ where: { id: param(req.params.id), uploaderId: user.id, storeId: null, purpose: MediaPurpose.PLATFORM_CONTENT, uploadStatus: 'COMPLETE', scanStatus: 'QUARANTINED', storageProvider: 'OBJECT' } });
    if (!asset) throw fail(404, 'Quarantined content media not found.');
    if (!scanner) {
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: Buffer.alloc(0), scanner, actorId: user.id });
      return res.status(202).json({ ...scan, message: 'The malware scanner is unavailable. The file remains private.' });
    }
    if (!storage) throw fail(503, 'Managed private media storage is unavailable. The file remains private.');
    try {
      const read = await storage.readLimited(asset.storageKey, mediaLimit(asset.kind));
      const scan = await scanQuarantinedMedia({ assetId: asset.id, bytes: read.bytes, scanner, actorId: user.id });
      return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json(scan);
    } catch {
      return res.status(503).json({ error: 'The private media object could not be read for scanning. It remains quarantined; retry later.', code: 'MEDIA_READ_UNAVAILABLE' });
    }
  }));
  app.post('/api/admin/content/media', express.raw({ type: '*/*', limit: '60mb' }), requireAuth, requireRole(...contentRoles), run(async (_req, res) => res.status(410).json({ error: 'Direct CMS media uploads are no longer supported. Use the short-lived private upload flow.' })));
  app.delete('/api/admin/content/media/:id', requireAuth, requireRole(...adminOnly), run(async (req, res) => { const id = param(req.params.id); const asset = await prisma.mediaAsset.findFirst({ where: { id, storeId: null } }); if (!asset) return res.status(404).json({ error: 'Media not found' }); const [featured, og, posts, pages, productImages, productMedia, branding, stores, avatars] = await Promise.all([prisma.blogPost.count({ where: { storeId: null, featuredImageId: id } }), prisma.blogPost.count({ where: { storeId: null, ogImageId: id } }), prisma.blogPost.findMany({ where: { storeId: null }, select: { bodyJson: true } }), prisma.contentPage.findMany({ where: { storeId: null }, select: { bodyJson: true } }), prisma.productImage.count({ where: { mediaAssetId: id } }), prisma.productMedia.count({ where: { mediaAssetId: id } }), prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { draftJson: true, publishedJson: true } }), prisma.store.findMany({ select: { logoMediaId: true, bannerMediaId: true, themeDraftJson: true, themePublishedJson: true } }), prisma.user.count({ where: { avatarMediaId: id } })]); if (featured || og || productImages || productMedia || avatars || stores.some(store => store.logoMediaId === id || store.bannerMediaId === id || JSON.stringify([store.themeDraftJson, store.themePublishedJson]).includes(id)) || [...posts, ...pages].some(item => JSON.stringify(item.bodyJson).includes(id)) || JSON.stringify(branding ?? {}).includes(id)) throw fail(409, 'Media is still referenced by content or a product'); await prisma.mediaAsset.delete({ where: { id } }); await audit(actor(res).id, 'CONTENT_MEDIA_DELETED', 'MediaAsset', id); res.status(204).send(); }));
}
