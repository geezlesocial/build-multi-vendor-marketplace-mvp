import crypto from 'node:crypto';
import path from 'node:path';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import { ContentStatus, MediaKind, MediaScanStatus, Role, Prisma } from '@prisma/client';
import { env } from './config.js';
import { audit, prisma, requireAuth, requireRole } from './security.js';
import { contentActionSchema, contentWriteSchema, mediaExtension, pageWriteSchema, slugPath } from './content-validation.js';
import { contentStorage } from './content-storage.js';
import { renderBlocks, renderDocument } from './content-renderer.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const contentRoles = [Role.ADMIN, Role.CONTENT_EDITOR];
const adminOnly = [Role.ADMIN];
const now = () => new Date();
function publishedWhere(): Prisma.BlogPostWhereInput {
  return { status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] };
}

function pagePublishedWhere(): Prisma.ContentPageWhereInput {
  return { status: ContentStatus.PUBLISHED, OR: [{ publishedAt: null }, { publishedAt: { lte: now() } }] };
}
const reservedSlugs = new Set(['api', 'admin', 'blog', 'pages', 'content-media', 'content-preview', 'health', 'ready', 'robots.txt', 'sitemap.xml']);

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
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids } }, select: { id: true, scanStatus: true } });
  if (assets.length !== new Set(ids).size) throw fail(400, 'One or more media assets do not exist');
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
  const [posts, pages, branding, stores] = await Promise.all([
    prisma.blogPost.findMany({ where: publishedWhere(), select: { bodyJson: true, featuredImageId: true, ogImageId: true } }),
    prisma.contentPage.findMany({ where: pagePublishedWhere(), select: { bodyJson: true, ogImageId: true } }),
    prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } }),
    prisma.store.findMany({ where: { seller: { status: 'APPROVED' }, themePublishedJson: { not: Prisma.JsonNull } }, select: { logoMediaId: true, bannerMediaId: true, themePublishedJson: true } })
  ]);
  const referencedInPublishedContent = posts.some(item => item.featuredImageId === id || item.ogImageId === id || JSON.stringify(item.bodyJson).includes(id)) || pages.some(item => item.ogImageId === id || JSON.stringify(item.bodyJson).includes(id)) || JSON.stringify(branding?.publishedJson ?? {}).includes(id) || stores.some(item => item.logoMediaId === id || item.bannerMediaId === id || JSON.stringify(item.themePublishedJson).includes(id));
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

export function registerContentRoutes(app: Express) {
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
    const [posts, pages] = await Promise.all([prisma.blogPost.findMany({ where: publishedWhere(), select: { slug: true, updatedAt: true, canonicalUrl: true, noIndex: true } }), prisma.contentPage.findMany({ where: pagePublishedWhere(), select: { slug: true, updatedAt: true, canonicalUrl: true, noIndex: true } })]);
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const urls = [...posts.filter(post => !post.noIndex).map(post => ({ loc: post.canonicalUrl || publicUrl('blog', post.slug), lastmod: post.updatedAt })), ...pages.filter(page => !page.noIndex).map(page => ({ loc: page.canonicalUrl || publicUrl('pages', page.slug), lastmod: page.updatedAt }))];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${escape(url.loc)}</loc><lastmod>${url.lastmod.toISOString()}</lastmod></url>`).join('')}</urlset>`);
  }));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /content-preview/\nSitemap: ${env.SITE_URL}/sitemap.xml\n`));
  app.get('/content-media/:id', run(async (req, res) => { const asset = await publicMediaAsset(param(req.params.id)); if (!asset) return res.status(404).send('Media not found'); res.setHeader('Content-Type', asset.detectedMime); res.setHeader('Content-Disposition', asset.kind === MediaKind.DOCUMENT || asset.kind === MediaKind.CAPTION ? `attachment; filename="${asset.safeName}"` : `inline; filename="${asset.safeName}"`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); contentStorage.open(asset.storageKey).on('error', () => { if (!res.headersSent) res.status(404).send('Media not found'); }).pipe(res); }));

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
  app.get('/api/admin/content/media', requireAuth, requireRole(...contentRoles), run(async (_req, res) => res.json(await prisma.mediaAsset.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, originalName: true, safeName: true, kind: true, detectedMime: true, sizeBytes: true, scanStatus: true, altText: true, caption: true, createdAt: true } }))));
  app.post('/api/admin/content/media', express.raw({ type: '*/*', limit: '60mb' }), requireAuth, requireRole(...contentRoles), run(async (req, res) => { if (!Buffer.isBuffer(req.body)) throw fail(400, 'Upload bytes are required'); const originalName = req.get('x-original-name')?.slice(0, 255) || 'upload'; const extension = mediaExtension(originalName); const claimedMime = req.get('content-type') || 'application/octet-stream'; const signature = fileSignature(req.body, extension, claimedMime); const limit = signature.kind === MediaKind.IMAGE ? env.CONTENT_MAX_IMAGE_BYTES : signature.kind === MediaKind.VIDEO ? env.CONTENT_MAX_VIDEO_BYTES : env.CONTENT_MAX_DOCUMENT_BYTES; if (req.body.length > limit) throw fail(413, 'File exceeds the configured size limit'); const id = crypto.randomUUID(); const storageKey = `${id}.${signature.extension}`; await contentStorage.put(storageKey, req.body); const user = actor(res); const asset = await prisma.mediaAsset.create({ data: { id, storageKey, originalName, safeName: originalName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120), kind: signature.kind, detectedMime: signature.mime, sizeBytes: req.body.length, checksum: crypto.createHash('sha256').update(req.body).digest('hex'), uploaderId: user.id, altText: req.get('x-media-alt')?.slice(0, 300), caption: req.get('x-media-caption')?.slice(0, 500), scanStatus: env.NODE_ENV === 'production' || env.CONTENT_SCAN_REQUIRED ? MediaScanStatus.QUARANTINED : MediaScanStatus.APPROVED } }); await audit(user.id, 'CONTENT_MEDIA_UPLOADED', 'MediaAsset', asset.id, { kind: asset.kind, sizeBytes: asset.sizeBytes, scanStatus: asset.scanStatus }); res.status(201).json({ id: asset.id, kind: asset.kind, detectedMime: asset.detectedMime, sizeBytes: asset.sizeBytes, scanStatus: asset.scanStatus }); }));
  app.delete('/api/admin/content/media/:id', requireAuth, requireRole(...adminOnly), run(async (req, res) => { const id = param(req.params.id); const asset = await prisma.mediaAsset.findUnique({ where: { id } }); if (!asset) return res.status(404).json({ error: 'Media not found' }); const [featured, og, posts, pages] = await Promise.all([prisma.blogPost.count({ where: { featuredImageId: id } }), prisma.blogPost.count({ where: { ogImageId: id } }), prisma.blogPost.findMany({ select: { bodyJson: true } }), prisma.contentPage.findMany({ select: { bodyJson: true } })]); if (featured || og || [...posts, ...pages].some(item => JSON.stringify(item.bodyJson).includes(id))) throw fail(409, 'Media is still referenced by content'); await prisma.mediaAsset.delete({ where: { id } }); await audit(actor(res).id, 'CONTENT_MEDIA_DELETED', 'MediaAsset', id); res.status(204).send(); }));
}
