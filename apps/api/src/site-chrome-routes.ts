import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ContentStatus, MediaKind, MediaScanStatus, MediaUploadStatus, Role, SellerStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth } from './security.js';
import { authorizedBrandingStore } from './store-branding-access.js';
import { paidStoreChromeAccess, defaultSiteChrome, platformChromePageKeys, platformContentPageKey, resolvePublishedSiteChrome, siteChromeSchema, storeChromeConfigurationId, storeChromePageKeys, storeContentPageKey, type SiteChromeConfiguration } from './site-chrome-domain.js';
import { brandingSchema, storeThemeSchema } from './platform-domain.js';
import { siteChromeStyles } from './site-chrome-renderer.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const jsonInput = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const versionSchema = z.object({ expectedVersion: z.number().int().min(0).max(2_000_000_000), reason: z.string().trim().max(500).optional() }).strict();
const saveSchema = versionSchema.extend({ configuration: siteChromeSchema }).strict();
const storeRoles: Role[] = [Role.SELLER, Role.CASHIER];
type ChromeActor = { id: string; role: Role; sellerId?: string };
function actor(res: Response) { return res.locals.user as ChromeActor; }

function safeGlobalBranding(value: unknown) {
  const result = brandingSchema.safeParse(value);
  return result.success ? result.data : brandingSchema.parse({ platformName: 'Market Lane', shortName: 'Market Lane', tagline: 'Independent marketplace' });
}

async function visibilityOptions(storeId?: string) {
  if (!storeId) {
    const [pages, posts] = await Promise.all([
      prisma.contentPage.findMany({ where: { storeId: null, status: { not: ContentStatus.ARCHIVED } }, select: { id: true, title: true, slug: true }, orderBy: { title: 'asc' }, take: 100 }),
      prisma.blogPost.findMany({ where: { storeId: null, status: { not: ContentStatus.ARCHIVED } }, select: { id: true, title: true, slug: true }, orderBy: { title: 'asc' }, take: 100 })
    ]);
    return [
      { key: 'PLATFORM_HOME', label: 'Marketplace home' },
      { key: 'PLATFORM_SHOP', label: 'Shop and catalog' },
      { key: 'PLATFORM_FAVORITES', label: 'Favorites' },
      { key: 'PLATFORM_DASHBOARD', label: 'Account dashboards' },
      { key: 'PLATFORM_BLOG_INDEX', label: 'Blog landing page' },
      { key: 'PLATFORM_PRODUCT', label: 'Product detail pages' },
      { key: 'PLATFORM_CATEGORY', label: 'Category pages' },
      ...pages.map(page => ({ key: platformContentPageKey('PAGE', page.id), label: `Page · ${page.title} (${page.slug})` })),
      ...posts.map(post => ({ key: platformContentPageKey('POST', post.id), label: `Blog post · ${post.title} (${post.slug})` }))
    ];
  }
  const [pages, posts] = await Promise.all([
    prisma.contentPage.findMany({ where: { storeId, status: { not: ContentStatus.ARCHIVED } }, select: { id: true, title: true, slug: true }, orderBy: { title: 'asc' }, take: 100 }),
    prisma.blogPost.findMany({ where: { storeId, status: { not: ContentStatus.ARCHIVED } }, select: { id: true, title: true, slug: true }, orderBy: { title: 'asc' }, take: 100 })
  ]);
  return [
    { key: 'STORE_HOME', label: 'Store homepage' },
    { key: 'STORE_PRODUCT', label: 'This Store product detail pages' },
    ...pages.map(page => ({ key: storeContentPageKey('PAGE', page.id), label: `Store page · ${page.title} (${page.slug})` })),
    ...posts.map(post => ({ key: storeContentPageKey('POST', post.id), label: `Store blog · ${post.title} (${post.slug})` }))
  ];
}

async function validateVisibilityKeys(configuration: SiteChromeConfiguration, storeId?: string) {
  const keys = configuration.suppressedPageKeys;
  const staticKeys = storeId ? storeChromePageKeys : platformChromePageKeys;
  const dynamic = keys.filter(key => !staticKeys.has(key));
  const pageIds = dynamic.flatMap(key => {
    const prefix = storeId ? 'STORE_PAGE:' : 'PLATFORM_PAGE:';
    return key.startsWith(prefix) ? [{ id: key.slice(prefix.length), type: 'page' as const }] : [];
  });
  const postIds = dynamic.flatMap(key => {
    const prefix = storeId ? 'STORE_POST:' : 'PLATFORM_POST:';
    return key.startsWith(prefix) ? [{ id: key.slice(prefix.length), type: 'post' as const }] : [];
  });
  if (dynamic.length !== pageIds.length + postIds.length) throw fail(400, 'A selected footer visibility page is not part of this website. Refresh the page list and try again.');
  const [pages, posts] = await Promise.all([
    pageIds.length ? prisma.contentPage.count({ where: { id: { in: pageIds.map(item => item.id) }, storeId: storeId ?? null, status: { not: ContentStatus.ARCHIVED } } }) : 0,
    postIds.length ? prisma.blogPost.count({ where: { id: { in: postIds.map(item => item.id) }, storeId: storeId ?? null, status: { not: ContentStatus.ARCHIVED } } }) : 0
  ]);
  if (pages !== pageIds.length || posts !== postIds.length) throw fail(400, 'A selected footer visibility page is no longer available in this website.');
}

async function checkChromeMedia(configuration: SiteChromeConfiguration, storeId: string | null, publish: boolean) {
  const ids = [...new Set([configuration.header.logoMediaId, configuration.footer.logoMediaId].filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids }, storeId, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE }, select: { id: true, scanStatus: true } });
  if (assets.length !== ids.length) throw fail(400, 'A logo asset is unavailable or belongs to another website.');
  if (assets.some(asset => asset.scanStatus === MediaScanStatus.REJECTED)) throw fail(409, 'Rejected logo media cannot be used.');
  if (publish && assets.some(asset => asset.scanStatus !== MediaScanStatus.APPROVED)) throw fail(409, 'Logo media must pass safety scanning before publication.');
}

async function chromeForScope(id: string, storeId: string | null) {
  const record = await prisma.siteChromeConfiguration.findUnique({ where: { id } });
  return {
    scope: storeId ? 'STORE' : 'PLATFORM',
    scopeId: id,
    draft: record ? siteChromeSchema.parse(record.draftJson) : defaultSiteChrome(),
    published: record?.publishedJson ? siteChromeSchema.safeParse(record.publishedJson).data ?? null : null,
    draftVersion: record?.draftVersion ?? 0,
    publishedVersion: record?.publishedVersion ?? null,
    updatedAt: record?.updatedAt ?? null,
    pages: await visibilityOptions(storeId ?? undefined)
  };
}

async function saveDraft(id: string, storeId: string | null, configuration: SiteChromeConfiguration, expectedVersion: number, actorId: string, reason: string) {
  await validateVisibilityKeys(configuration, storeId ?? undefined);
  await checkChromeMedia(configuration, storeId, false);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 194821))`;
    const existing = await tx.siteChromeConfiguration.findUnique({ where: { id }, select: { draftVersion: true } });
    if ((existing?.draftVersion ?? 0) !== expectedVersion) throw fail(409, 'This site chrome draft changed in another session. Reload the latest version before saving.');
    const version = expectedVersion + 1;
    const saved = await tx.siteChromeConfiguration.upsert({
      where: { id },
      create: { id, storeId, draftJson: jsonInput(configuration), draftVersion: version },
      update: { draftJson: jsonInput(configuration), draftVersion: version }
    });
    await tx.siteChromeRevision.create({ data: { configurationId: id, version, configurationJson: jsonInput(configuration), editorId: actorId, changeNote: reason.slice(0, 500) } });
    await tx.auditLog.create({ data: { actorId, action: 'SITE_CHROME_DRAFT_SAVED', entity: 'SiteChromeConfiguration', entityId: id, metadata: { version, headerTemplate: configuration.header.template, footerTemplate: configuration.footer.template, suppressedPageCount: configuration.suppressedPageKeys.length } } });
    return saved;
  });
}

async function publishDraft(id: string, storeId: string | null, expectedVersion: number, actorId: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 194821))`;
    const current = await tx.siteChromeConfiguration.findUnique({ where: { id } });
    if (!current) throw fail(404, 'Save a site chrome draft before publishing.');
    if (current.draftVersion !== expectedVersion) throw fail(409, 'This draft changed in another session. Reload it before publishing.');
    const configuration = siteChromeSchema.parse(current.draftJson);
    await validateVisibilityKeys(configuration, storeId ?? undefined);
    const ids = [...new Set([configuration.header.logoMediaId, configuration.footer.logoMediaId].filter((assetId): assetId is string => Boolean(assetId)))];
    if (ids.length) {
      const assets = await tx.mediaAsset.findMany({ where: { id: { in: ids }, storeId, kind: MediaKind.IMAGE, uploadStatus: MediaUploadStatus.COMPLETE, scanStatus: MediaScanStatus.APPROVED }, select: { id: true } });
      if (assets.length !== ids.length) throw fail(409, 'All logos must belong to this website and pass safety scanning before publication.');
    }
    const published = await tx.siteChromeConfiguration.update({ where: { id }, data: { publishedJson: jsonInput(configuration), publishedVersion: expectedVersion, publishedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId, action: 'SITE_CHROME_PUBLISHED', entity: 'SiteChromeConfiguration', entityId: id, metadata: { version: expectedVersion, scope: storeId ? 'STORE' : 'PLATFORM' } } });
    return published;
  });
}

async function revisions(id: string) {
  return prisma.siteChromeRevision.findMany({ where: { configurationId: id }, orderBy: { version: 'desc' }, take: 50, select: { version: true, changeNote: true, createdAt: true, editor: { select: { id: true, name: true, email: true } } } });
}

type PageKind = 'HOME' | 'SHOP' | 'FAVORITES' | 'DASHBOARD' | 'BLOG_INDEX' | 'PAGE' | 'POST' | 'PRODUCT' | 'CATEGORY' | 'CHECKOUT';
function pageKind(value: unknown): PageKind | null {
  return typeof value === 'string' && ['HOME', 'SHOP', 'FAVORITES', 'DASHBOARD', 'BLOG_INDEX', 'PAGE', 'POST', 'PRODUCT', 'CATEGORY', 'CHECKOUT'].includes(value) ? value as PageKind : null;
}

async function publicPageKey(storeId: string | null, kind: PageKind | null, slug: string) {
  if (!kind) return null;
  if (storeId) {
    if (kind === 'HOME') return 'STORE_HOME';
    if (kind === 'PRODUCT') return 'STORE_PRODUCT';
    if (kind === 'PAGE' && slug) {
      const page = await prisma.contentPage.findFirst({ where: { storeId, slug, status: ContentStatus.PUBLISHED }, select: { id: true } });
      return page ? storeContentPageKey('PAGE', page.id) : null;
    }
    if (kind === 'POST' && slug) {
      const post = await prisma.blogPost.findFirst({ where: { storeId, slug, status: ContentStatus.PUBLISHED }, select: { id: true } });
      return post ? storeContentPageKey('POST', post.id) : null;
    }
    return null;
  }
  if (kind === 'HOME') return 'PLATFORM_HOME';
  if (kind === 'SHOP') return 'PLATFORM_SHOP';
  if (kind === 'FAVORITES') return 'PLATFORM_FAVORITES';
  if (kind === 'DASHBOARD') return 'PLATFORM_DASHBOARD';
  if (kind === 'BLOG_INDEX') return 'PLATFORM_BLOG_INDEX';
  if (kind === 'PRODUCT') return 'PLATFORM_PRODUCT';
  if (kind === 'CATEGORY') return 'PLATFORM_CATEGORY';
  if (kind === 'PAGE' && slug) {
    const page = await prisma.contentPage.findFirst({ where: { storeId: null, slug, status: ContentStatus.PUBLISHED }, select: { id: true } });
    return page ? platformContentPageKey('PAGE', page.id) : null;
  }
  if (kind === 'POST' && slug) {
    const post = await prisma.blogPost.findFirst({ where: { storeId: null, slug, status: ContentStatus.PUBLISHED }, select: { id: true } });
    return post ? platformContentPageKey('POST', post.id) : null;
  }
  return null;
}

export function registerSiteChromeRoutes(app: Express) {
  app.get('/api/site-chrome/public', run(async (req, res) => {
    const storeSlug = param(req.query.storeSlug as string | undefined).trim();
    let store: { id: string; name: string; slug: string; themePublishedJson: unknown; logoMediaId: string | null; description: string | null } | null = null;
    if (storeSlug) {
      store = await prisma.store.findFirst({ where: { slug: storeSlug, seller: { status: SellerStatus.APPROVED } }, select: { id: true, name: true, slug: true, themePublishedJson: true, logoMediaId: true, description: true } });
      if (!store) return res.status(404).setHeader('Cache-Control', 'no-store').json({ configuration: null, publishedVersion: null, footerSuppressed: false, scope: 'STORE', brand: null });
    }
    const kind = pageKind(req.query.kind);
    const slug = param(req.query.slug as string | undefined).trim();
    if (!store && kind === 'PRODUCT' && slug) {
      const product = await prisma.product.findFirst({
        where: { id: slug, status: 'APPROVED', OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] },
        select: {
          seller: {
            select: {
              store: {
                select: {
                  id: true, name: true, slug: true, themePublishedJson: true,
                  logoMediaId: true, description: true, isPlatformStore: true,
                },
              },
            },
          },
        },
      });
      const productStore = product?.seller?.store;
      if (productStore && !productStore.isPlatformStore) store = productStore;
    }
    if (!store && kind === 'CATEGORY' && slug && !await prisma.category.findFirst({ where: { slug, status: 'ACTIVE' }, select: { id: true } })) {
      return res.status(404).setHeader('Cache-Control', 'no-store').json({ error: 'Category not found.' });
    }
    if (!store && kind === 'PRODUCT' && slug && !await prisma.product.findFirst({ where: { id: slug, status: 'APPROVED', OR: [{ sellerId: null }, { seller: { status: SellerStatus.APPROVED } }] }, select: { id: true } })) {
      return res.status(404).setHeader('Cache-Control', 'no-store').json({ error: 'Product not found.' });
    }
    const pageKey = await publicPageKey(store?.id ?? null, kind, slug);
    const effective = await resolvePublishedSiteChrome({ storeId: store?.id, pageKey: pageKey ?? undefined });
    let brand: Record<string, unknown>;
    if (store) {
      const theme = storeThemeSchema.safeParse(store.themePublishedJson ?? {});
      brand = { title: store.name, description: store.description ?? '', logoMediaId: theme.success ? theme.data.logoMediaId : store.logoMediaId, path: `/store/${store.slug}` };
    } else {
      const identity = safeGlobalBranding((await prisma.platformBranding.findUnique({ where: { id: 'default' }, select: { publishedJson: true } }))?.publishedJson);
      brand = { title: identity.shortName || identity.platformName, description: identity.description, tagline: identity.tagline, logoMediaId: identity.logoMediaId ?? identity.alternateLogoMediaId, path: '/' };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...effective, scope: store ? 'STORE' : 'PLATFORM', brand });
  }));

  app.get('/api/site-chrome/public.css', run(async (req, res) => {
    const storeSlug = param(req.query.storeSlug as string | undefined).trim();
    let configuration: SiteChromeConfiguration | null = null;
    if (storeSlug) {
      const store = await prisma.store.findFirst({ where: { slug: storeSlug, seller: { status: SellerStatus.APPROVED } }, select: { id: true } });
      if (!store) return res.status(404).type('text').send('/* Store not found */');
      configuration = (await resolvePublishedSiteChrome({ storeId: store.id })).configuration;
    } else {
      configuration = (await resolvePublishedSiteChrome({})).configuration;
    }
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.send(siteChromeStyles(configuration ?? defaultSiteChrome()));
  }));

  app.get('/api/admin/site-chrome', requireAuth, run(async (_req, res) => {
    const current = res.locals.user as ChromeActor | undefined;
    if (!current || current.role !== Role.ADMIN) throw fail(403, 'Platform administrator permission required.');
    const [state, history] = await Promise.all([chromeForScope('platform', null), revisions('platform')]);
    res.json({ ...state, revisions: history });
  }));
  app.put('/api/admin/site-chrome', requireAuth, run(async (req, res) => {
    const current = res.locals.user as ChromeActor | undefined;
    if (!current || current.role !== Role.ADMIN) throw fail(403, 'Platform administrator permission required.');
    const input = saveSchema.parse(req.body);
    const saved = await saveDraft('platform', null, input.configuration, input.expectedVersion, current.id, input.reason ?? 'Platform site chrome draft');
    res.json({ draftVersion: saved.draftVersion, updatedAt: saved.updatedAt });
  }));
  app.post('/api/admin/site-chrome/publish', requireAuth, run(async (req, res) => {
    const current = res.locals.user as ChromeActor | undefined;
    if (!current || current.role !== Role.ADMIN) throw fail(403, 'Platform administrator permission required.');
    const input = versionSchema.parse(req.body);
    const published = await publishDraft('platform', null, input.expectedVersion, current.id);
    res.json({ publishedVersion: published.publishedVersion, publishedAt: published.publishedAt });
  }));
  app.post('/api/admin/site-chrome/revisions/:version/restore', requireAuth, run(async (req, res) => {
    const current = res.locals.user as ChromeActor | undefined;
    if (!current || current.role !== Role.ADMIN) throw fail(403, 'Platform administrator permission required.');
    const input = versionSchema.parse(req.body);
    const version = Number(param(req.params.version));
    const revision = Number.isInteger(version) && version > 0 ? await prisma.siteChromeRevision.findUnique({ where: { configurationId_version: { configurationId: 'platform', version } } }) : null;
    if (!revision) throw fail(404, 'Site chrome revision not found.');
    const saved = await saveDraft('platform', null, siteChromeSchema.parse(revision.configurationJson), input.expectedVersion, current.id, input.reason ?? `Restored revision ${version}`);
    res.json({ draftVersion: saved.draftVersion, updatedAt: saved.updatedAt });
  }));

  app.get('/api/seller/site-chrome', requireAuth, run(async (_req, res) => {
    const current = actor(res);
    if (!storeRoles.includes(current.role) || !current.sellerId) throw fail(403, 'Seller workspace permission required.');
    const store = await authorizedBrandingStore(current);
    if (!store) throw fail(403, 'Approved Store owner or authorized branding staff required.');
    const eligible = await paidStoreChromeAccess(prisma, store.id);
    const [state, history] = await Promise.all([chromeForScope(storeChromeConfigurationId(store.id), store.id), revisions(storeChromeConfigurationId(store.id))]);
    res.json({ ...state, eligible, store: { id: store.id, name: store.name, slug: store.slug }, revisions: history });
  }));
  app.put('/api/seller/site-chrome', requireAuth, run(async (req, res) => {
    const current = actor(res);
    if (!storeRoles.includes(current.role) || !current.sellerId) throw fail(403, 'Seller workspace permission required.');
    const store = await authorizedBrandingStore(current);
    if (!store || store.isPlatformStore) throw fail(403, 'Only paid seller Stores can customize their storefront chrome.');
    if (!await paidStoreChromeAccess(prisma, store.id)) throw fail(403, 'A currently active paid Store subscription is required. Saved drafts are preserved.');
    const input = saveSchema.parse(req.body);
    const saved = await saveDraft(storeChromeConfigurationId(store.id), store.id, input.configuration, input.expectedVersion, current.id, input.reason ?? 'Store site chrome draft');
    res.json({ draftVersion: saved.draftVersion, updatedAt: saved.updatedAt });
  }));
  app.post('/api/seller/site-chrome/publish', requireAuth, run(async (req, res) => {
    const current = actor(res);
    if (!storeRoles.includes(current.role) || !current.sellerId) throw fail(403, 'Seller workspace permission required.');
    const store = await authorizedBrandingStore(current);
    if (!store || store.isPlatformStore || !await paidStoreChromeAccess(prisma, store.id)) throw fail(403, 'A currently active paid Store subscription is required to publish.');
    const input = versionSchema.parse(req.body);
    const published = await publishDraft(storeChromeConfigurationId(store.id), store.id, input.expectedVersion, current.id);
    res.json({ publishedVersion: published.publishedVersion, publishedAt: published.publishedAt });
  }));
  app.post('/api/seller/site-chrome/revisions/:version/restore', requireAuth, run(async (req, res) => {
    const current = actor(res);
    if (!storeRoles.includes(current.role) || !current.sellerId) throw fail(403, 'Seller workspace permission required.');
    const store = await authorizedBrandingStore(current);
    if (!store || store.isPlatformStore || !await paidStoreChromeAccess(prisma, store.id)) throw fail(403, 'A currently active paid Store subscription is required to restore a revision.');
    const id = storeChromeConfigurationId(store.id);
    const input = versionSchema.parse(req.body);
    const version = Number(param(req.params.version));
    const revision = Number.isInteger(version) && version > 0 ? await prisma.siteChromeRevision.findUnique({ where: { configurationId_version: { configurationId: id, version } } }) : null;
    if (!revision) throw fail(404, 'Site chrome revision not found.');
    const saved = await saveDraft(id, store.id, siteChromeSchema.parse(revision.configurationJson), input.expectedVersion, current.id, input.reason ?? `Restored revision ${version}`);
    res.json({ draftVersion: saved.draftVersion, updatedAt: saved.updatedAt });
  }));

  app.get('/api/site-chrome/health', (_req, res) => res.json({ ok: true }));
}
