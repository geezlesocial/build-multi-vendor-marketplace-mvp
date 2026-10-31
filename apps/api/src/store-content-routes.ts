import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { ContentStatus, MediaKind, MediaScanStatus, MediaUploadStatus, Role, SellerStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { contentActionSchema, contentWriteSchema, pageWriteSchema } from './content-validation.js';
import { storeEntitlements } from './store-plan-domain.js';
import { env } from './config.js';
import { renderBlocks, renderDocument } from './content-renderer.js';
import { defaultSiteChrome, resolvePublishedSiteChrome, storeContentPageKey } from './site-chrome-domain.js';
import { renderSiteChromeFooter, renderSiteChromeHeader } from './site-chrome-renderer.js';
import { storeThemeSchema } from './platform-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string, extra?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...extra });
const actor = (res: Response) => res.locals.user as { id: string; sellerId?: string };
const jsonInput = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const due = () => ({ OR: [{ publishedAt: null }, { publishedAt: { lte: new Date() } }] });
type ContentDb = typeof prisma | Prisma.TransactionClient;

async function approvedStore(sellerId: string) {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED }, include: { store: true } });
  if (!seller?.store) throw fail(403, 'An approved seller Store is required.');
  return seller.store;
}

function mediaIds(body: unknown, featuredImageId?: string, ogImageId?: string) {
  const blockIds = (Array.isArray(body) ? body : []).flatMap((block: { mediaId?: string; captionMediaId?: string }) => [block.mediaId, block.captionMediaId].filter((id): id is string => Boolean(id)));
  return [...new Set([...blockIds, featuredImageId, ogImageId].filter((id): id is string => Boolean(id)))];
}

async function assertStoreMedia(db: ContentDb, storeId: string, ids: string[], requireApproved: boolean) {
  if (!ids.length) return;
  const assets = await db.mediaAsset.findMany({ where: { id: { in: ids }, storeId, uploadStatus: 'COMPLETE' }, select: { id: true, scanStatus: true } });
  if (assets.length !== ids.length) throw fail(400, 'Media must be uploaded to this Store and finish processing before it can be referenced.');
  if (assets.some(asset => asset.scanStatus === MediaScanStatus.REJECTED)) throw fail(409, 'Rejected media cannot be used in Store content. Choose a different file.');
  if (requireApproved && assets.some(asset => asset.scanStatus !== MediaScanStatus.APPROVED)) throw fail(409, 'Media remains quarantined until the configured malware scanning process approves it.');
}

function assertAdvancedFields(raw: unknown, enabled: boolean) {
  if (!raw || typeof raw !== 'object') return;
  const body = raw as Record<string, unknown>;
  if (body.noIndex !== undefined || body.noFollow !== undefined || body.navPlacement !== undefined || body.navLabel !== undefined || body.navOrder !== undefined || body.canonicalUrl !== undefined) {
    throw fail(403, 'Store editors cannot change indexing or platform navigation settings.');
  }
  if (!enabled && ['seoTitle', 'seoDescription', 'ogImageId'].some(key => body[key] !== undefined)) {
    throw fail(409, 'Advanced content SEO is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'advancedContentSeoEnabled', planUrl: '/seller/plan' });
  }
}

async function storeQuota(storeId: string) {
  return storeEntitlements(prisma, storeId);
}

async function assertNoPageCycle(db: ContentDb, storeId: string, pageId: string | null, parentId: string | undefined) {
  const visited = new Set<string>();
  let cursor = parentId;
  while (cursor) {
    if (cursor === pageId || visited.has(cursor)) throw fail(400, 'Page parent would create a cycle.');
    if (visited.size >= 100) throw fail(400, 'Page hierarchy exceeds the supported depth.');
    visited.add(cursor);
    const parent = await db.contentPage.findFirst({ where: { id: cursor, storeId }, select: { parentId: true } });
    if (!parent) throw fail(400, 'Parent page must belong to this Store.');
    cursor = parent.parentId ?? undefined;
  }
}

export function registerStoreContentRoutes(app: Express) {
  app.get('/api/seller/store-content', requireAuth, requireRole(Role.SELLER), run(async (_req, res) => {
    const user = actor(res);
    if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const store = await approvedStore(user.sellerId);
    const [posts, pages, entitlements] = await Promise.all([
      prisma.blogPost.findMany({ where: { storeId: store.id }, orderBy: { updatedAt: 'desc' }, take: 100 }),
      prisma.contentPage.findMany({ where: { storeId: store.id }, orderBy: { updatedAt: 'desc' }, take: 100 }),
      storeQuota(store.id)
    ]);
    res.json({ store: { id: store.id, name: store.name, slug: store.slug }, posts, pages, entitlements, publicPrefix: `/store/${store.slug}` });
  }));

  app.post('/api/seller/store-content/posts', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const input = contentWriteSchema.parse(req.body);
    if (req.body?.scheduledAt) throw fail(409, 'Create a draft first, then schedule it only if scheduled publishing is included.');
    const result = await prisma.$transaction(async tx => {
      const store = await tx.store.findFirst({ where: { sellerId: user.sellerId, seller: { status: SellerStatus.APPROVED } } });
      if (!store) throw fail(403, 'An approved seller Store is required.');
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = await storeEntitlements(tx, store.id);
      const usage = await tx.blogPost.count({ where: { storeId: store.id, status: { not: ContentStatus.ARCHIVED } } });
      if (usage >= entitlements.blogPostLimit) throw fail(409, 'Your Store has reached its blog post limit.', { code: 'PLAN_LIMIT_REACHED', entitlement: 'blogPostLimit', usage, limit: entitlements.blogPostLimit, upgradeRequired: true, planUrl: '/seller/plan' });
      if (await tx.blogPost.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw fail(409, 'That content URL is already in use.');
      await assertStoreMedia(tx, store.id, mediaIds(input.body, input.featuredImageId, input.ogImageId), false);
      assertAdvancedFields(req.body, entitlements.advancedContentSeoEnabled);
      const post = await tx.blogPost.create({ data: {
        storeId: store.id, title: input.title, slug: input.slug, excerpt: input.excerpt, bodyJson: jsonInput(input.body), authorId: user.id, editorId: user.id,
        featuredImageId: input.featuredImageId, ogImageId: input.ogImageId,
        ...(entitlements.advancedContentSeoEnabled ? { seoTitle: input.seoTitle, seoDescription: input.seoDescription } : {}),
        noIndex: false, noFollow: false, tags: { create: input.tags.map(tag => ({ tag: { connectOrCreate: { where: { slug: tag.slug }, create: tag } } })) }
      } });
      await tx.blogPostRevision.create({ data: { postId: post.id, revisionNumber: 1, title: post.title, slug: post.slug, excerpt: post.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_CONTENT_POST_CREATED', entity: 'BlogPost', entityId: post.id, metadata: jsonInput({ storeId: store.id, slug: post.slug }) } });
      return post;
    });
    res.status(201).json(result);
  }));

  app.post('/api/seller/store-content/pages', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId) throw fail(403, 'Seller scope required.');
    const input = pageWriteSchema.parse(req.body);
    if (req.body?.scheduledAt) throw fail(409, 'Create a draft first, then schedule it only if scheduled publishing is included.');
    const result = await prisma.$transaction(async tx => {
      const store = await tx.store.findFirst({ where: { sellerId: user.sellerId, seller: { status: SellerStatus.APPROVED } } });
      if (!store) throw fail(403, 'An approved seller Store is required.');
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const entitlements = await storeEntitlements(tx, store.id);
      const usage = await tx.contentPage.count({ where: { storeId: store.id, status: { not: ContentStatus.ARCHIVED } } });
      if (usage >= entitlements.contentPageLimit) throw fail(409, 'Your Store has reached its page limit.', { code: 'PLAN_LIMIT_REACHED', entitlement: 'contentPageLimit', usage, limit: entitlements.contentPageLimit, upgradeRequired: true, planUrl: '/seller/plan' });
      if (await tx.contentPage.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw fail(409, 'That content URL is already in use.');
      await assertNoPageCycle(tx, store.id, null, input.parentId);
      await assertStoreMedia(tx, store.id, mediaIds(input.body, undefined, input.ogImageId), false);
      assertAdvancedFields(req.body, entitlements.advancedContentSeoEnabled);
      const page = await tx.contentPage.create({ data: {
        storeId: store.id, title: input.title, slug: input.slug, bodyJson: jsonInput(input.body), pageType: input.pageType, parentId: input.parentId,
        navPlacement: 'NONE', navLabel: null, navOrder: 0, editorId: user.id, ogImageId: input.ogImageId,
        ...(entitlements.advancedContentSeoEnabled ? { seoTitle: input.seoTitle, seoDescription: input.seoDescription } : {}), noIndex: false, noFollow: false
      } });
      await tx.contentPageRevision.create({ data: { pageId: page.id, revisionNumber: 1, slug: page.slug, title: page.title, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_CONTENT_PAGE_CREATED', entity: 'ContentPage', entityId: page.id, metadata: jsonInput({ storeId: store.id, slug: page.slug }) } });
      return page;
    });
    res.status(201).json(result);
  }));

  app.patch('/api/seller/store-content/:kind/:id', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId || !['posts', 'pages'].includes(param(req.params.kind))) throw fail(404, 'Store content not found.');
    const store = await approvedStore(user.sellerId);
    const kind = param(req.params.kind);
    if (req.body?.scheduledAt) throw fail(409, 'Use the schedule action only when scheduled publishing is included.');
    const entitlements = await storeQuota(store.id);
    assertAdvancedFields(req.body, entitlements.advancedContentSeoEnabled);
    if (kind === 'posts') {
      const input = contentWriteSchema.parse(req.body);
      const existing = await prisma.blogPost.findFirst({ where: { id: param(req.params.id), storeId: store.id } });
      if (!existing) throw fail(404, 'Store content not found.');
      if (input.slug !== existing.slug && await prisma.blogPost.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw fail(409, 'That content URL is already in use.');
      await assertStoreMedia(prisma, store.id, mediaIds(input.body, input.featuredImageId, input.ogImageId), false);
      const updated = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const currentEntitlements = await storeEntitlements(tx, store.id);
        assertAdvancedFields(req.body, currentEntitlements.advancedContentSeoEnabled);
        const prior = await tx.blogPost.findFirst({ where: { id: existing.id, storeId: store.id } });
        if (!prior) throw fail(404, 'Store content not found.');
        await assertStoreMedia(tx, store.id, mediaIds(input.body, input.featuredImageId, input.ogImageId), prior.status === ContentStatus.PUBLISHED);
        const changed = await tx.blogPost.update({ where: { id: prior.id }, data: { title: input.title, slug: input.slug, excerpt: input.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, featuredImageId: input.featuredImageId, ogImageId: input.ogImageId, ...(currentEntitlements.advancedContentSeoEnabled ? { seoTitle: input.seoTitle, seoDescription: input.seoDescription } : {}) } });
        const revisionNumber = (await tx.blogPostRevision.findFirst({ where: { postId: prior.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0;
        await tx.blogPostRevision.create({ data: { postId: prior.id, revisionNumber: revisionNumber + 1, title: changed.title, slug: changed.slug, excerpt: changed.excerpt, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } });
        if (prior.status === ContentStatus.PUBLISHED && prior.slug !== changed.slug) await tx.slugRedirect.create({ data: { fromPath: `/store/${store.slug}/blog/${prior.slug}`, destinationPath: `/store/${store.slug}/blog/${changed.slug}`, createdById: user.id } });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_CONTENT_UPDATED', entity: 'BlogPost', entityId: changed.id, metadata: jsonInput({ storeId: store.id, slug: changed.slug }) } });
        return changed;
      });
      return res.json(updated);
    }
    const input = pageWriteSchema.parse(req.body);
    const existing = await prisma.contentPage.findFirst({ where: { id: param(req.params.id), storeId: store.id } });
    if (!existing) throw fail(404, 'Store content not found.');
    if (input.slug !== existing.slug && await prisma.contentPage.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw fail(409, 'That content URL is already in use.');
    if (input.parentId && !await prisma.contentPage.findFirst({ where: { id: input.parentId, storeId: store.id }, select: { id: true } })) throw fail(400, 'Parent page must belong to this Store.');
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const currentEntitlements = await storeEntitlements(tx, store.id);
      assertAdvancedFields(req.body, currentEntitlements.advancedContentSeoEnabled);
      const prior = await tx.contentPage.findFirst({ where: { id: existing.id, storeId: store.id } });
      if (!prior) throw fail(404, 'Store content not found.');
      await assertNoPageCycle(tx, store.id, prior.id, input.parentId);
      await assertStoreMedia(tx, store.id, mediaIds(input.body, undefined, input.ogImageId), prior.status === ContentStatus.PUBLISHED);
      const changed = await tx.contentPage.update({ where: { id: prior.id }, data: { title: input.title, slug: input.slug, bodyJson: jsonInput(input.body), pageType: input.pageType, parentId: input.parentId, editorId: user.id, ogImageId: input.ogImageId, ...(currentEntitlements.advancedContentSeoEnabled ? { seoTitle: input.seoTitle, seoDescription: input.seoDescription } : {}) } });
      const revisionNumber = (await tx.contentPageRevision.findFirst({ where: { pageId: prior.id }, orderBy: { revisionNumber: 'desc' }, select: { revisionNumber: true } }))?.revisionNumber ?? 0;
      await tx.contentPageRevision.create({ data: { pageId: prior.id, revisionNumber: revisionNumber + 1, slug: changed.slug, title: changed.title, bodyJson: jsonInput(input.body), editorId: user.id, changeNote: input.changeNote } });
      if (prior.status === ContentStatus.PUBLISHED && prior.slug !== changed.slug) await tx.slugRedirect.create({ data: { fromPath: `/store/${store.slug}/pages/${prior.slug}`, destinationPath: `/store/${store.slug}/pages/${changed.slug}`, createdById: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'STORE_CONTENT_UPDATED', entity: 'ContentPage', entityId: changed.id, metadata: jsonInput({ storeId: store.id, slug: changed.slug }) } });
      return changed;
    });
    res.json(updated);
  }));

  app.post('/api/seller/store-content/:kind/:id/action', requireAuth, requireRole(Role.SELLER), run(async (req, res) => {
    const user = actor(res);
    if (!user.sellerId || !['posts', 'pages'].includes(param(req.params.kind))) throw fail(404, 'Store content not found.');
    const store = await approvedStore(user.sellerId);
    const kind = param(req.params.kind) === 'posts' ? 'post' : 'page';
    const input = contentActionSchema.parse(req.body);
    const entitlements = await storeQuota(store.id);
    if (input.action === 'schedule') {
      if (!entitlements.scheduledPublishingEnabled) throw fail(409, 'Scheduled publishing is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'scheduledPublishingEnabled', planUrl: '/seller/plan' });
      if (!input.scheduledAt || new Date(input.scheduledAt) <= new Date()) throw fail(400, 'A future schedule time is required.');
    }
    const data = input.action === 'publish'
      ? { status: ContentStatus.PUBLISHED, publishedAt: new Date(), scheduledAt: null, archivedAt: null }
      : input.action === 'schedule'
        ? { status: ContentStatus.SCHEDULED, scheduledAt: new Date(input.scheduledAt!), publishedAt: null }
        : input.action === 'unpublish'
          ? { status: ContentStatus.DRAFT, scheduledAt: null }
          : input.action === 'archive'
            ? { status: ContentStatus.ARCHIVED, archivedAt: new Date() }
            : { status: ContentStatus.DRAFT, archivedAt: null };
    const changed = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
      const record = kind === 'post'
        ? await tx.blogPost.findFirst({ where: { id: param(req.params.id), storeId: store.id } })
        : await tx.contentPage.findFirst({ where: { id: param(req.params.id), storeId: store.id } });
      if (!record) throw fail(404, 'Store content not found.');
      const lockedEntitlements = await storeEntitlements(tx, store.id);
      if (input.action === 'schedule' && !lockedEntitlements.scheduledPublishingEnabled) throw fail(409, 'Scheduled publishing is not enabled for this plan.', { code: 'PLAN_FEATURE_NOT_ENABLED', entitlement: 'scheduledPublishingEnabled', planUrl: '/seller/plan' });
      if (input.action === 'publish' || input.action === 'schedule') {
        await assertStoreMedia(tx, store.id, mediaIds(record.bodyJson, 'featuredImageId' in record ? record.featuredImageId ?? undefined : undefined, record.ogImageId ?? undefined), input.action === 'publish');
      }
      const updated = kind === 'post'
        ? await tx.blogPost.updateMany({ where: { id: record.id, storeId: store.id }, data })
        : await tx.contentPage.updateMany({ where: { id: record.id, storeId: store.id }, data });
      if (updated.count !== 1) throw fail(404, 'Store content not found.');
      const content = kind === 'post' ? await tx.blogPost.findUnique({ where: { id: record.id } }) : await tx.contentPage.findUnique({ where: { id: record.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: `STORE_CONTENT_${kind.toUpperCase()}_${input.action.toUpperCase()}`, entity: kind === 'post' ? 'BlogPost' : 'ContentPage', entityId: record.id, metadata: jsonInput({ storeId: store.id, reason: input.reason }) } });
      return content;
    });
    res.json(changed);
  }));

  app.get('/api/stores/:slug/content', run(async (req, res) => {
    const store = await prisma.store.findFirst({ where: { slug: param(req.params.slug), seller: { status: SellerStatus.APPROVED } }, select: { id: true } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });
    const [posts, pages] = await Promise.all([
      prisma.blogPost.findMany({ where: { storeId: store.id, status: ContentStatus.PUBLISHED, ...due() }, select: { slug: true, title: true, excerpt: true, publishedAt: true, updatedAt: true }, orderBy: { publishedAt: 'desc' } }),
      prisma.contentPage.findMany({ where: { storeId: store.id, status: ContentStatus.PUBLISHED, ...due() }, select: { slug: true, title: true, pageType: true, publishedAt: true, updatedAt: true }, orderBy: { updatedAt: 'desc' } })
    ]);
    res.json({ posts, pages });
  }));

  const renderStoreContent = (kind: 'post' | 'page') => run(async (req, res) => {
    const storeSlug = param(req.params.storeSlug); const slug = param(req.params.contentSlug);
    const store = await prisma.store.findFirst({ where: { slug: storeSlug, seller: { status: SellerStatus.APPROVED } }, select: { id: true, name: true, slug: true, themePublishedJson: true, logoMediaId: true, description: true } });
    if (!store) return res.status(404).type('html').send('<!doctype html><title>Not found</title><h1>Not found</h1>');
    const item = kind === 'post'
      ? await prisma.blogPost.findFirst({ where: { storeId: store.id, slug, status: ContentStatus.PUBLISHED, ...due() } })
      : await prisma.contentPage.findFirst({ where: { storeId: store.id, slug, status: ContentStatus.PUBLISHED, ...due() } });
    if (!item) {
      const fromPath = `/store/${store.slug}/${kind === 'post' ? 'blog' : 'pages'}/${slug}`;
      const redirect = await prisma.slugRedirect.findUnique({ where: { fromPath } });
      if (redirect) return res.redirect(redirect.statusCode, redirect.destinationPath);
      return res.status(404).type('html').send('<!doctype html><title>Not found</title><h1>Not found</h1>');
    }
    const excerpt = kind === 'post' ? (item as { excerpt?: string | null }).excerpt : null;
    const theme = store.themePublishedJson && typeof store.themePublishedJson === 'object' && !Array.isArray(store.themePublishedJson) ? store.themePublishedJson as { faviconMediaId?: unknown } : {};
    const faviconId = typeof theme.faviconMediaId === 'string' ? theme.faviconMediaId : null;
    const favicon = faviconId ? await prisma.mediaAsset.findFirst({ where: { id: faviconId, storeId: store.id, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED }, select: { id: true } }) : null;
    const chromeState = await resolvePublishedSiteChrome({ storeId: store.id, pageKey: storeContentPageKey(kind === 'post' ? 'POST' : 'PAGE', item.id) });
    const chrome = chromeState.configuration ?? defaultSiteChrome();
    const parsedTheme = storeThemeSchema.safeParse(store.themePublishedJson ?? {});
    const brand = { title: store.name, tagline: '', description: store.description ?? (parsedTheme.success ? parsedTheme.data.description : ''), logoMediaId: parsedTheme.success ? parsedTheme.data.logoMediaId ?? store.logoMediaId : store.logoMediaId, path: `/store/${store.slug}` };
    const categories = chrome.header.showCategoryLinks ? await prisma.category.findMany({ where: { status: 'ACTIVE' }, select: { name: true, slug: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }], take: 12 }) : [];
    const chromeStylesHref = `/api/site-chrome/public.css?storeSlug=${encodeURIComponent(store.slug)}&v=${chromeState.publishedVersion ?? 0}`;
    res.type('html').send(renderDocument({ title: item.seoTitle || item.title, description: item.seoDescription || excerpt || item.title, canonical: `${env.SITE_URL}/store/${store.slug}/${kind === 'post' ? 'blog' : 'pages'}/${item.slug}`, body: renderBlocks(item.bodyJson), type: kind === 'post' ? 'BlogPosting' : 'WebPage', publishedAt: item.publishedAt, updatedAt: item.updatedAt, noIndex: false, noFollow: false, imageUrl: null, breadcrumb: store.name, siteName: store.name, faviconUrl: favicon ? `/content-media/${encodeURIComponent(favicon.id)}` : null, marketplaceAdPlacement: kind === 'post', chromeHeader: renderSiteChromeHeader(chrome, brand, categories), chromeFooter: renderSiteChromeFooter(chrome, brand, chromeState.footerSuppressed), chromeStylesHref, platformDisclosure: `Platform payments are collected by the marketplace owner; automated seller payouts are not included.` }));
  });
  app.get('/store/:storeSlug/blog/:contentSlug', renderStoreContent('post'));
  app.get('/store/:storeSlug/pages/:contentSlug', renderStoreContent('page'));
}
