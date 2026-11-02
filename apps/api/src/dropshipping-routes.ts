import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { Prisma, ProductStatus, Role, SellerStatus, TaxonomyStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { asStorePlanEntitlements, effectiveStorePlan, isAtLimit, storeEntitlements } from './store-plan-domain.js';
import { decryptDropshippingCredentials, encryptDropshippingCredentials, CJ_API_ROOT, CJ_PROVIDER, cjCallSucceeded, cleanSupplierDescription, safeCjImageUrl, supplierProductList, validCjResponse, type CjCredentials } from './dropshipping-domain.js';
import { decimalToMinorExact } from './currency-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string; role: Role; sellerId?: string };
const connectSchema = z.object({ apiKey: z.string().trim().min(24).max(200) }).strict();
const importSchema = z.object({ productId: z.string().trim().min(1).max(100), priceMinor: z.number().int().min(1).max(2_000_000_000), stock: z.number().int().min(0).max(2_000_000_000).default(0) }).strict();

type SellerStore = { id: string; sellerId: string; name: string; baseCurrency: string; isPlatformStore: boolean };
type CjEnvelope = { code: number; result?: boolean; success?: boolean; message?: string; data?: unknown };

async function sellerStoreAndPlan(sellerId: string | undefined, role: Role) {
  if (role === Role.ADMIN) {
    const platformStore = await prisma.store.findFirst({ where: { isPlatformStore: true, seller: { status: SellerStatus.APPROVED } }, select: { id: true, sellerId: true, name: true, baseCurrency: true, isPlatformStore: true, seller: { select: { id: true } } } });
    if (!platformStore) throw fail(409, 'Create the official platform Store in Control Center before using platform dropshipping.');
    return { seller: platformStore.seller, store: platformStore as SellerStore, effective: null };
  }
  if (!sellerId) throw fail(403, 'Approved seller Store required.');
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, status: SellerStatus.APPROVED }, select: { id: true, store: { select: { id: true, sellerId: true, name: true, baseCurrency: true } } } });
  if (!seller?.store) throw fail(403, 'Approved seller Store required.');
  const effective = await effectiveStorePlan(prisma, seller.store.id);
  const entitlements = asStorePlanEntitlements(effective.version);
  if (!entitlements.dropshippingEnabled || !effective.version || effective.plan?.key === 'legacy-compatible') {
    throw fail(403, 'Supplier dropshipping is available only on an active paid Store plan that includes this feature. Visit Plan & Billing to review eligibility.');
  }
  return { seller, store: seller.store as SellerStore, effective };
}

async function cjRequest(path: string, token?: string, body?: Record<string, unknown>) {
  const response = await fetch(`${CJ_API_ROOT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { 'CJ-Access-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw fail(502, 'The supplier API could not complete the request. Try again later.');
  const payload: unknown = await response.json().catch(() => null);
  if (!validCjResponse(payload)) throw fail(502, 'The supplier returned an unrecognized response.');
  if (!cjCallSucceeded(payload)) throw fail(502, 'The supplier API rejected the request. Check the connected account and try again.');
  return payload as CjEnvelope;
}

function credentialsFromTokenResponse(apiKey: string, envelope: CjEnvelope): CjCredentials {
  const data = envelope.data as Record<string, unknown> | undefined;
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : '';
  const refreshToken = typeof data?.refreshToken === 'string' ? data.refreshToken : '';
  const accessExpiry = typeof data?.accessTokenExpiryDate === 'string' ? data.accessTokenExpiryDate : '';
  const refreshExpiry = typeof data?.refreshTokenExpiryDate === 'string' ? data.refreshTokenExpiryDate : '';
  if (!accessToken || !refreshToken || !Number.isFinite(Date.parse(accessExpiry)) || !Number.isFinite(Date.parse(refreshExpiry))) throw fail(502, 'The supplier did not return usable access credentials.');
  return { apiKey, accessToken, refreshToken, accessTokenExpiresAt: accessExpiry, refreshTokenExpiresAt: refreshExpiry };
}

async function credentialsForConnection(connection: { id: string; encryptedCredentials: string }, storeId: string) {
  let credentials = decryptDropshippingCredentials(connection.encryptedCredentials);
  const refreshBeforeMs = Date.now() + 5 * 60_000;
  if (Date.parse(credentials.accessTokenExpiresAt) <= refreshBeforeMs) {
    try {
      if (Date.parse(credentials.refreshTokenExpiresAt) <= Date.now()) throw new Error('Refresh token expired');
      const response = await cjRequest('/authentication/refreshAccessToken', undefined, { refreshToken: credentials.refreshToken });
      credentials = credentialsFromTokenResponse(credentials.apiKey, response);
    } catch {
      const response = await cjRequest('/authentication/getAccessToken', undefined, { apiKey: credentials.apiKey });
      credentials = credentialsFromTokenResponse(credentials.apiKey, response);
    }
    await prisma.storeDropshippingConnection.update({ where: { id: connection.id }, data: { encryptedCredentials: encryptDropshippingCredentials(credentials), lastCheckedAt: new Date(), status: 'CONNECTED' } });
  } else {
    await prisma.storeDropshippingConnection.updateMany({ where: { id: connection.id, storeId }, data: { lastCheckedAt: new Date(), status: 'CONNECTED' } });
  }
  return credentials;
}

function safeSupplierProduct(item: Record<string, unknown>) {
  const id = typeof item.id === 'string' ? item.id : '';
  const name = typeof item.nameEn === 'string' ? item.nameEn.trim() : '';
  const sku = typeof item.sku === 'string' ? item.sku : typeof item.spu === 'string' ? item.spu : '';
  const amount = typeof item.nowPrice === 'string' || typeof item.nowPrice === 'number' ? String(item.nowPrice) : typeof item.sellPrice === 'string' || typeof item.sellPrice === 'number' ? String(item.sellPrice) : '';
  let costUsdMinor: number | null = null;
  try { costUsdMinor = decimalToMinorExact(amount, 2); } catch { /* Supplier price is display-only if its precision is unsupported. */ }
  const stockNumber = Number(item.totalVerifiedInventory ?? item.warehouseInventoryNum ?? 0);
  return {
    id, name: name.slice(0, 200), sku: sku.slice(0, 200), costUsdMinor,
    availableStockSnapshot: Number.isSafeInteger(stockNumber) && stockNumber >= 0 ? stockNumber : null,
    imageUrl: safeCjImageUrl(item.bigImage), saleStatus: String(item.saleStatus ?? '')
  };
}

export function registerDropshippingRoutes(app: Express) {
  app.get('/api/seller/dropshipping', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (_req, res) => {
    const user = actor(res);
    const { store, effective } = await sellerStoreAndPlan(user.sellerId, user.role);
    const [connection, imports] = await Promise.all([
      prisma.storeDropshippingConnection.findUnique({ where: { storeId_provider: { storeId: store.id, provider: CJ_PROVIDER } }, select: { id: true, provider: true, status: true, connectedAt: true, lastCheckedAt: true } }),
      prisma.supplierProductImport.findMany({ where: { storeId: store.id }, include: { product: { select: { id: true, name: true, status: true, priceMinor: true, currency: true, inventory: { select: { quantity: true } } } } }, orderBy: { importedAt: 'desc' }, take: 100 })
    ]);
    res.json({
      store: { id: store.id, name: store.name, baseCurrency: store.baseCurrency },
      entitlement: { enabled: true, plan: effective?.version?.name ?? 'Platform admin override — all premium features', adminOverride: user.role === Role.ADMIN, requiresSubscription: false },
      providers: [
        { code: CJ_PROVIDER, name: 'CJdropshipping', status: 'AVAILABLE', apiReady: true, docsUrl: 'https://developers.cjdropshipping.com/en/', note: 'Free API access is available; product and delivery costs still apply.' },
        { code: 'ALIEXPRESS', name: 'AliExpress Dropshipping', status: 'APPROVAL_REQUIRED', apiReady: false, docsUrl: 'https://developer.alibaba.com/docs/doc.htm?articleId=120418&docType=1&treeId=762', note: 'Requires an approved Dropshipping AppKey and an AliExpress Dropshipping Center account.' },
        { code: 'ALIBABA_COM', name: 'Alibaba.com Open Platform', status: 'APPROVAL_REQUIRED', apiReady: false, docsUrl: 'https://openapi.alibaba.com/doc/doc.htm', note: 'Requires developer registration, app review, and API permissions; not a drop-in AliExpress product feed.' }
      ],
      connection: connection ? { ...connection, connected: connection.status === 'CONNECTED' } : null,
      imports: imports.map(item => ({ id: item.id, provider: item.provider, externalProductId: item.externalProductId, externalSku: item.externalSku, supplierCostUsdMinor: item.supplierCostUsdMinor, importedAt: item.importedAt, product: item.product }))
    });
  }));

  app.post('/api/seller/dropshipping/connections/cj', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const { store } = await sellerStoreAndPlan(user.sellerId, user.role);
    const input = connectSchema.parse(req.body);
    const envelope = await cjRequest('/authentication/getAccessToken', undefined, { apiKey: input.apiKey });
    const credentials = credentialsFromTokenResponse(input.apiKey, envelope);
    const connection = await prisma.storeDropshippingConnection.upsert({
      where: { storeId_provider: { storeId: store.id, provider: CJ_PROVIDER } },
      create: { storeId: store.id, provider: CJ_PROVIDER, encryptedCredentials: encryptDropshippingCredentials(credentials), status: 'CONNECTED', lastCheckedAt: new Date() },
      update: { encryptedCredentials: encryptDropshippingCredentials(credentials), status: 'CONNECTED', connectedAt: new Date(), lastCheckedAt: new Date() },
      select: { id: true, provider: true, status: true, connectedAt: true, lastCheckedAt: true }
    });
    await prisma.auditLog.create({ data: { actorId: user.id, action: 'DROPSHIPPING_PROVIDER_CONNECTED', entity: 'StoreDropshippingConnection', entityId: connection.id, metadata: { storeId: store.id, provider: CJ_PROVIDER } } });
    res.status(201).json({ ...connection, connected: true });
  }));

  app.delete('/api/seller/dropshipping/connections/cj', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (_req, res) => {
    const user = actor(res);
    const { store } = await sellerStoreAndPlan(user.sellerId, user.role);
    const removed = await prisma.storeDropshippingConnection.deleteMany({ where: { storeId: store.id, provider: CJ_PROVIDER } });
    if (removed.count) await prisma.auditLog.create({ data: { actorId: user.id, action: 'DROPSHIPPING_PROVIDER_DISCONNECTED', entity: 'StoreDropshippingConnection', metadata: { storeId: store.id, provider: CJ_PROVIDER } } });
    res.status(204).send();
  }));

  app.get('/api/seller/dropshipping/products', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const { store } = await sellerStoreAndPlan(user.sellerId, user.role);
    const query = z.string().trim().min(2).max(100).parse(req.query.q);
    const connection = await prisma.storeDropshippingConnection.findUnique({ where: { storeId_provider: { storeId: store.id, provider: CJ_PROVIDER } }, select: { id: true, encryptedCredentials: true, status: true } });
    if (!connection || connection.status !== 'CONNECTED') throw fail(409, 'Connect a CJdropshipping account before searching supplier products.');
    const credentials = await credentialsForConnection(connection, store.id);
    const url = new URL(`${CJ_API_ROOT}/product/listV2`);
    url.searchParams.set('page', '1'); url.searchParams.set('size', '20'); url.searchParams.set('keyWord', query);
    const response = await fetch(url, { headers: { 'CJ-Access-Token': credentials.accessToken }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw fail(502, 'The supplier search is temporarily unavailable.');
    const envelope: unknown = await response.json().catch(() => null);
    if (!validCjResponse(envelope) || !cjCallSucceeded(envelope)) throw fail(502, 'The supplier search returned an invalid response.');
    const items = supplierProductList(envelope.data).map(safeSupplierProduct).filter(product => product.id && product.name && product.saleStatus === '3');
    const existing = items.length ? await prisma.supplierProductImport.findMany({ where: { storeId: store.id, provider: CJ_PROVIDER, externalProductId: { in: items.map(item => item.id) } }, select: { externalProductId: true } }) : [];
    const importedIds = new Set(existing.map(item => item.externalProductId));
    res.json({ query, products: items.map(item => ({ ...item, imported: importedIds.has(item.id) })) });
  }));

  app.post('/api/seller/dropshipping/imports', requireAuth, requireRole(Role.SELLER, Role.ADMIN), run(async (req, res) => {
    const user = actor(res);
    const { seller, store, effective } = await sellerStoreAndPlan(user.sellerId, user.role);
    const adminOverride = user.role === Role.ADMIN && store.isPlatformStore;
    const input = importSchema.parse(req.body);
    const connection = await prisma.storeDropshippingConnection.findUnique({ where: { storeId_provider: { storeId: store.id, provider: CJ_PROVIDER } }, select: { id: true, encryptedCredentials: true, status: true } });
    if (!connection || connection.status !== 'CONNECTED') throw fail(409, 'Connect a CJdropshipping account before importing supplier products.');
    if (await prisma.supplierProductImport.findUnique({ where: { storeId_provider_externalProductId: { storeId: store.id, provider: CJ_PROVIDER, externalProductId: input.productId } }, select: { id: true } })) throw fail(409, 'This supplier product has already been imported into your Store.');
    const credentials = await credentialsForConnection(connection, store.id);
    const detailUrl = new URL(`${CJ_API_ROOT}/product/query`); detailUrl.searchParams.set('pid', input.productId);
    const response = await fetch(detailUrl, { headers: { 'CJ-Access-Token': credentials.accessToken }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw fail(502, 'The supplier could not provide product details.');
    const payload: unknown = await response.json().catch(() => null);
    if (!validCjResponse(payload) || !cjCallSucceeded(payload) || !payload.data || typeof payload.data !== 'object') throw fail(502, 'The supplier returned invalid product details.');
    const source = payload.data as Record<string, unknown>;
    if (String(source.status ?? '3') !== '3') throw fail(409, 'This supplier product is no longer approved for sale.');
    const name = (typeof source.productNameEn === 'string' ? source.productNameEn : '').trim().slice(0, 120);
    const sku = (typeof source.productSku === 'string' ? source.productSku : '').trim().slice(0, 200);
    if (!name || !sku) throw fail(502, 'Supplier product is missing a usable name or SKU.');
    let supplierCostUsdMinor: number | null = null;
    try { supplierCostUsdMinor = decimalToMinorExact(String(source.sellPrice), 2); } catch { /* Informational only; seller chooses the retail price. */ }
    const description = cleanSupplierDescription(source.description) || `Imported supplier listing (${sku}). Review and complete product details before publication.`;
    const images = [...new Set([source.bigImage, ...(Array.isArray(source.productImageSet) ? source.productImageSet : [])].map(safeCjImageUrl).filter((image): image is string => !!image))].slice(0, 12);
    const categoryName = typeof source.categoryName === 'string' ? source.categoryName.split(/[>/,]/).map(value => value.trim()).filter(Boolean).at(-1) : undefined;
    const physicalType = await prisma.catalogProductType.findFirst({ where: { slug: 'physical-product', status: TaxonomyStatus.ACTIVE }, select: { id: true } });
    if (!physicalType) throw fail(409, 'An administrator must activate the physical product type before supplier listings can be imported.');
    const matchingCategory = categoryName ? await prisma.category.findFirst({ where: { status: TaxonomyStatus.ACTIVE, name: { equals: categoryName, mode: 'insensitive' } }, orderBy: { displayOrder: 'asc' }, select: { id: true } }) : null;
    try {
      const product = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const entitlements = await storeEntitlements(tx, store.id, effective?.version);
        if (!adminOverride && (!entitlements.dropshippingEnabled || !effective?.version || effective.plan?.key === 'legacy-compatible')) throw fail(403, 'Your active Store plan no longer includes dropshipping.');
        const [count, duplicate] = await Promise.all([
          tx.product.count({ where: { sellerId: seller.id, status: { not: ProductStatus.ARCHIVED } } }),
          tx.supplierProductImport.findUnique({ where: { storeId_provider_externalProductId: { storeId: store.id, provider: CJ_PROVIDER, externalProductId: input.productId } }, select: { id: true } })
        ]);
        if (duplicate) throw fail(409, 'This supplier product has already been imported into your Store.');
        if (!adminOverride && isAtLimit(count, entitlements.productLimit)) throw fail(409, 'Your Store has reached its product limit. Upgrade your plan or archive a product before importing more.');
        const imported = await tx.product.create({ data: {
          sellerId: seller.id, categoryId: matchingCategory?.id ?? null, productTypeId: physicalType.id,
          name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'supplier-product'}-${Math.random().toString(36).slice(2, 8)}`,
          description, priceMinor: input.priceMinor, currency: store.baseCurrency, status: ProductStatus.PENDING,
          barcode: sku, inventory: { create: { quantity: input.stock } },
          images: { create: images.map(url => ({ url, alt: name })) }
        }, include: { inventory: true } });
        await tx.supplierProductImport.create({ data: { storeId: store.id, productId: imported.id, provider: CJ_PROVIDER, externalProductId: input.productId, externalSku: sku, supplierCostUsdMinor, sourceUrl: `https://cjdropshipping.com/product/${encodeURIComponent(input.productId)}` } });
        await tx.auditLog.create({ data: { actorId: user.id, action: 'DROPSHIPPING_PRODUCT_IMPORTED', entity: 'Product', entityId: imported.id, metadata: { storeId: store.id, provider: CJ_PROVIDER, externalProductId: input.productId, sourceSku: sku } } });
        return imported;
      });
      res.status(201).json({ product, message: 'Imported as a pending listing. Review it and keep supplier stock and pricing current before requesting publication.' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'This supplier product has already been imported into your Store.');
      throw error;
    }
  }));
}
