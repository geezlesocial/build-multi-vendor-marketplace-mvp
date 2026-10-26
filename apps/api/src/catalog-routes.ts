import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { CatalogSuggestionKind, CatalogSuggestionStatus, Prisma, PrismaClient, Role, TaxonomyStatus } from '@prisma/client';
import { z } from 'zod';
import { audit, prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const database = (db: PrismaClient | Prisma.TransactionClient = prisma) => db;

export async function validateProductCatalogSelection(input: { categoryId?: string | null; brandId?: string | null; productTypeId?: string | null; featureIds?: string[] }, db: PrismaClient | Prisma.TransactionClient = prisma) {
  const categoryIds: string[] = [];
  let currentId = input.categoryId ?? null;
  while (currentId) {
    const category = await database(db).category.findFirst({ where: { id: currentId, status: TaxonomyStatus.ACTIVE }, select: { id: true, parentId: true } });
    if (!category) throw fail(400, 'Choose an active catalog category.');
    categoryIds.push(category.id);
    if (categoryIds.length > 3) throw fail(400, 'Product categories may be nested at most three levels.');
    currentId = category.parentId;
  }

  const brandId = input.brandId ?? null;
  if (brandId && !(await database(db).brand.findFirst({ where: { id: brandId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active catalog brand.');

  let productTypeId = input.productTypeId ?? null;
  if (productTypeId) {
    if (!(await database(db).catalogProductType.findFirst({ where: { id: productTypeId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active product type.');
  } else {
    const physical = await database(db).catalogProductType.findFirst({ where: { slug: 'physical-product', status: TaxonomyStatus.ACTIVE }, select: { id: true } });
    if (!physical) throw fail(409, 'An administrator must activate a product type before listings can be created.');
    productTypeId = physical.id;
  }

  const featureIds = [...new Set(input.featureIds ?? [])];
  if (featureIds.length) {
    const features = await database(db).catalogFeature.findMany({ where: { id: { in: featureIds }, status: TaxonomyStatus.ACTIVE }, select: { id: true, categoryId: true, productTypeId: true } });
    if (features.length !== featureIds.length) throw fail(400, 'One or more selected product features are no longer active. Refresh the catalog and try again.');
    if (features.some(feature => feature.categoryId && !categoryIds.includes(feature.categoryId))) throw fail(400, 'A selected feature is not available for this product category.');
    if (features.some(feature => feature.productTypeId && feature.productTypeId !== productTypeId)) throw fail(400, 'A selected feature is not available for this product type.');
  }
  return { categoryId: input.categoryId ?? null, brandId, productTypeId, featureIds };
}

const suggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CATEGORY'), name: z.string().trim().min(2).max(120) }).strict(),
  z.object({ kind: z.literal('CHILD_CATEGORY'), name: z.string().trim().min(2).max(120), parentCategoryId: z.string().cuid() }).strict(),
  z.object({ kind: z.literal('FEATURE'), name: z.string().trim().min(2).max(120), categoryId: z.string().cuid().nullable().optional() }).strict(),
  z.object({ kind: z.literal('BRAND'), name: z.string().trim().min(2).max(120) }).strict()
]);

function normalizedName(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'); }
function slugBase(value: string) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140) || 'catalog-item'; }
function actor(res: Response) { return res.locals.user as { id: string; role: Role }; }

export function registerCatalogRoutes(app: Express) {
  app.get('/api/catalog/taxonomy', run(async (_req, res) => {
    const [categories, brands, productTypes] = await Promise.all([
      prisma.category.findMany({ where: { status: TaxonomyStatus.ACTIVE }, select: { id: true, name: true, slug: true, parentId: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }),
      prisma.brand.findMany({ where: { status: TaxonomyStatus.ACTIVE }, select: { id: true, name: true, slug: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }),
      prisma.catalogProductType.findMany({ where: { status: TaxonomyStatus.ACTIVE }, select: { id: true, name: true, slug: true, requiresShipping: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] })
    ]);
    res.json({ categories, brands, productTypes });
  }));

  app.get('/api/catalog/features', run(async (req, res) => {
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const productTypeId = typeof req.query.productTypeId === 'string' ? req.query.productTypeId : undefined;
    const categoryIds: string[] = [];
    let currentId = categoryId ?? null;
    while (currentId) {
      const category = await prisma.category.findFirst({ where: { id: currentId, status: TaxonomyStatus.ACTIVE }, select: { id: true, parentId: true } });
      if (!category) throw fail(404, 'Category not found');
      categoryIds.push(category.id);
      if (categoryIds.length > 3) throw fail(400, 'Category nesting exceeds the supported depth.');
      currentId = category.parentId;
    }
    if (productTypeId && !(await prisma.catalogProductType.findFirst({ where: { id: productTypeId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(404, 'Product type not found.');
    const features = await prisma.catalogFeature.findMany({ where: { status: TaxonomyStatus.ACTIVE, AND: [
      { OR: [{ categoryId: null }, ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : [])] },
      { OR: [{ productTypeId: null }, ...(productTypeId ? [{ productTypeId }] : [])] }
    ] }, select: { id: true, name: true, categoryId: true, productTypeId: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
    res.json(features);
  }));

  app.get('/api/admin/catalog/product-types', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    res.json(await prisma.catalogProductType.findMany({ include: { _count: { select: { products: true, features: true } } }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }));
  }));

  app.post('/api/admin/catalog/product-types', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ name: z.string().trim().min(2).max(120), slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().trim().max(500).nullable().optional(), requiresShipping: z.boolean().default(true), displayOrder: z.number().int().min(0).max(100000).default(0), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE') }).strict().parse(req.body);
    const type = await prisma.catalogProductType.create({ data: input });
    await audit(admin.id, 'CATALOG_PRODUCT_TYPE_CREATED', 'CatalogProductType', type.id, { name: type.name, slug: type.slug });
    res.status(201).json(type);
  }));

  app.patch('/api/admin/catalog/product-types/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ name: z.string().trim().min(2).max(120).optional(), slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(), description: z.string().trim().max(500).nullable().optional(), requiresShipping: z.boolean().optional(), displayOrder: z.number().int().min(0).max(100000).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional() }).strict().refine(value => Object.keys(value).length > 0).parse(req.body);
    const existing = await prisma.catalogProductType.findUnique({ where: { id: param(req.params.id) } });
    if (!existing) throw fail(404, 'Product type not found.');
    const type = await prisma.catalogProductType.update({ where: { id: existing.id }, data: input });
    await audit(admin.id, 'CATALOG_PRODUCT_TYPE_UPDATED', 'CatalogProductType', type.id, { changed: Object.keys(input) });
    res.json(type);
  }));

  app.delete('/api/admin/catalog/product-types/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const existing = await prisma.catalogProductType.findUnique({ where: { id: param(req.params.id) }, include: { _count: { select: { products: true, features: true } } } });
    if (!existing) throw fail(404, 'Product type not found.');
    if (existing._count.products || existing._count.features) throw fail(409, 'Reassign or archive products and features before deleting this product type.');
    await prisma.catalogProductType.delete({ where: { id: existing.id } });
    await audit(admin.id, 'CATALOG_PRODUCT_TYPE_DELETED', 'CatalogProductType', existing.id, { name: existing.name });
    res.status(204).send();
  }));

  app.get('/api/admin/catalog/features', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    res.json(await prisma.catalogFeature.findMany({ include: { category: { select: { id: true, name: true } }, productType: { select: { id: true, name: true } }, _count: { select: { products: true } } }, orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }] }));
  }));

  app.post('/api/admin/catalog/features', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ name: z.string().trim().min(2).max(120), categoryId: z.string().cuid().nullable().optional(), productTypeId: z.string().min(1).nullable().optional(), displayOrder: z.number().int().min(0).max(100000).default(0) }).strict().parse(req.body);
    if (input.categoryId && !(await prisma.category.findFirst({ where: { id: input.categoryId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active category to scope this feature.');
    if (input.productTypeId && !(await prisma.catalogProductType.findFirst({ where: { id: input.productTypeId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active product type to scope this feature.');
    if (await prisma.catalogFeature.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, categoryId: input.categoryId ?? null, productTypeId: input.productTypeId ?? null }, select: { id: true } })) throw fail(409, 'That feature already exists for this product type and category.');
    const base = slugBase(input.name);
    let slug = base;
    let suffix = 2;
    while (await prisma.catalogFeature.findUnique({ where: { slug }, select: { id: true } })) slug = `${base.slice(0, 130)}-${suffix++}`;
    const feature = await prisma.catalogFeature.create({ data: { ...input, categoryId: input.categoryId ?? null, productTypeId: input.productTypeId ?? null, slug } });
    await audit(admin.id, 'CATALOG_FEATURE_CREATED', 'CatalogFeature', feature.id, { name: feature.name, categoryId: feature.categoryId, productTypeId: feature.productTypeId });
    res.status(201).json(feature);
  }));

  app.patch('/api/admin/catalog/features/:id/status', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']) }).strict().parse(req.body);
    const existing = await prisma.catalogFeature.findUnique({ where: { id: param(req.params.id) } });
    if (!existing) throw fail(404, 'Catalog feature not found.');
    const feature = await prisma.catalogFeature.update({ where: { id: existing.id }, data: { status: input.status } });
    await audit(admin.id, 'CATALOG_FEATURE_STATUS_CHANGED', 'CatalogFeature', feature.id, { oldStatus: existing.status, newStatus: feature.status });
    res.json(feature);
  }));

  app.patch('/api/admin/catalog/features/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ name: z.string().trim().min(2).max(120).optional(), categoryId: z.string().cuid().nullable().optional(), productTypeId: z.string().min(1).nullable().optional(), displayOrder: z.number().int().min(0).max(100000).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional() }).strict().refine(value => Object.keys(value).length > 0).parse(req.body);
    const existing = await prisma.catalogFeature.findUnique({ where: { id: param(req.params.id) } });
    if (!existing) throw fail(404, 'Catalog feature not found.');
    const nextCategoryId = input.categoryId === undefined ? existing.categoryId : input.categoryId;
    const nextTypeId = input.productTypeId === undefined ? existing.productTypeId : input.productTypeId;
    if (nextCategoryId && !(await prisma.category.findFirst({ where: { id: nextCategoryId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active category to scope this feature.');
    if (nextTypeId && !(await prisma.catalogProductType.findFirst({ where: { id: nextTypeId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active product type to scope this feature.');
    const nextName = input.name ?? existing.name;
    const duplicate = await prisma.catalogFeature.findFirst({ where: { id: { not: existing.id }, name: { equals: nextName, mode: 'insensitive' }, categoryId: nextCategoryId, productTypeId: nextTypeId }, select: { id: true } });
    if (duplicate) throw fail(409, 'That feature already exists for this product type and category.');
    const feature = await prisma.catalogFeature.update({ where: { id: existing.id }, data: input });
    await audit(admin.id, 'CATALOG_FEATURE_UPDATED', 'CatalogFeature', feature.id, { changed: Object.keys(input) });
    res.json(feature);
  }));

  app.delete('/api/admin/catalog/features/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const existing = await prisma.catalogFeature.findUnique({ where: { id: param(req.params.id) }, include: { _count: { select: { products: true } } } });
    if (!existing) throw fail(404, 'Catalog feature not found.');
    if (existing._count.products) throw fail(409, 'Remove or replace this feature on its products before deleting it.');
    await prisma.catalogFeature.delete({ where: { id: existing.id } });
    await audit(admin.id, 'CATALOG_FEATURE_DELETED', 'CatalogFeature', existing.id, { name: existing.name });
    res.status(204).send();
  }));

  app.post('/api/catalog/suggestions', requireAuth, run(async (req, res) => {
    const user = actor(res);
    const input = suggestionSchema.parse(req.body);
    const cleanName = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const normalized = normalizedName(cleanName);
    const parentCategoryId = input.kind === 'CHILD_CATEGORY' ? input.parentCategoryId : null;
    const categoryId = input.kind === 'FEATURE' ? input.categoryId ?? null : null;

    if (parentCategoryId) {
      const parent = await prisma.category.findFirst({ where: { id: parentCategoryId, status: TaxonomyStatus.ACTIVE }, select: { id: true, parentId: true } });
      if (!parent) throw fail(400, 'Choose an active parent category.');
      let depth = 1;
      let ancestorId = parent.parentId;
      while (ancestorId) {
        const ancestor = await prisma.category.findUnique({ where: { id: ancestorId }, select: { id: true, parentId: true } });
        if (!ancestor) break;
        depth += 1;
        ancestorId = ancestor.parentId;
      }
      if (depth >= 3) throw fail(400, 'Child categories may be nested at most three levels.');
    }
    if (categoryId && !(await prisma.category.findFirst({ where: { id: categoryId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(400, 'Choose an active category for this feature.');

    const duplicate = input.kind === 'CATEGORY' || input.kind === 'CHILD_CATEGORY'
      ? await prisma.category.findFirst({ where: { name: { equals: cleanName, mode: 'insensitive' } }, select: { id: true } })
      : input.kind === 'BRAND'
        ? await prisma.brand.findFirst({ where: { name: { equals: cleanName, mode: 'insensitive' } }, select: { id: true } })
        : await prisma.catalogFeature.findFirst({ where: { name: { equals: cleanName, mode: 'insensitive' }, categoryId }, select: { id: true } });
    if (duplicate) throw fail(409, 'That item is already in the active catalog. Refresh the choices.');
    const pending = await prisma.catalogSuggestion.findFirst({ where: { kind: input.kind, normalizedName: normalized, parentCategoryId, categoryId, status: CatalogSuggestionStatus.PENDING }, select: { id: true } });
    if (pending) throw fail(409, 'This suggestion is already awaiting review.');

    try {
      const suggestion = await prisma.catalogSuggestion.create({ data: { kind: input.kind as CatalogSuggestionKind, name: cleanName, normalizedName: normalized, parentCategoryId, categoryId, submittedById: user.id } });
      res.status(201).json({ id: suggestion.id, kind: suggestion.kind, name: suggestion.name, status: suggestion.status, message: 'Suggestion sent to the catalog review queue.' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'This suggestion is already awaiting review.');
      throw error;
    }
  }));

  app.get('/api/admin/catalog/suggestions', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const status = typeof req.query.status === 'string' && Object.values(CatalogSuggestionStatus).includes(req.query.status as CatalogSuggestionStatus) ? req.query.status as CatalogSuggestionStatus : CatalogSuggestionStatus.PENDING;
    res.json(await prisma.catalogSuggestion.findMany({ where: { status }, include: { parentCategory: { select: { id: true, name: true } }, featureCategory: { select: { id: true, name: true } }, submittedBy: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' }, take: 200 }));
  }));

  app.post('/api/admin/catalog/suggestions/:id/review', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reviewNote: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const item = await prisma.catalogSuggestion.findFirst({ where: { id: param(req.params.id), status: CatalogSuggestionStatus.PENDING }, include: { parentCategory: true, featureCategory: true } });
    if (!item) throw fail(404, 'Pending catalog suggestion not found.');

    if (input.decision === 'REJECT') {
      const updated = await prisma.catalogSuggestion.update({ where: { id: item.id }, data: { status: CatalogSuggestionStatus.REJECTED, reviewedById: admin.id, reviewedAt: new Date(), reviewNote: input.reviewNote ?? null } });
      await audit(admin.id, 'CATALOG_SUGGESTION_REJECTED', 'CatalogSuggestion', updated.id, { kind: updated.kind, name: updated.name, reviewNote: updated.reviewNote });
      return res.json(updated);
    }
    if (item.kind === CatalogSuggestionKind.CHILD_CATEGORY && !item.parentCategoryId) throw fail(409, 'This child-category suggestion has lost its parent. Ask the submitter to send it again.');
    if (item.kind === CatalogSuggestionKind.FEATURE && item.categoryId && !(await prisma.category.findFirst({ where: { id: item.categoryId, status: TaxonomyStatus.ACTIVE }, select: { id: true } }))) throw fail(409, 'The suggested feature category is no longer active.');

    const entity = await prisma.$transaction(async tx => {
      let created: { id: string; name: string };
      if (item.kind === CatalogSuggestionKind.CATEGORY || item.kind === CatalogSuggestionKind.CHILD_CATEGORY) {
        const existing = await tx.category.findFirst({ where: { name: { equals: item.name, mode: 'insensitive' } }, select: { id: true } });
        if (existing) throw fail(409, 'A matching category already exists. Resolve the duplicate and review this suggestion again.');
        let slug = slugBase(item.name);
        let suffix = 2;
        while (await tx.category.findUnique({ where: { slug }, select: { id: true } })) slug = `${slugBase(item.name).slice(0, 130)}-${suffix++}`;
        const parentId = item.kind === CatalogSuggestionKind.CHILD_CATEGORY ? item.parentCategoryId : null;
        if (parentId) {
          const parent = await tx.category.findFirst({ where: { id: parentId, status: TaxonomyStatus.ACTIVE }, select: { id: true, parentId: true } });
          if (!parent) throw fail(409, 'The suggested parent category is no longer active.');
          let depth = 1;
          let ancestorId = parent.parentId;
          while (ancestorId) { const ancestor = await tx.category.findUnique({ where: { id: ancestorId }, select: { parentId: true } }); if (!ancestor) break; depth += 1; ancestorId = ancestor.parentId; }
          if (depth >= 3) throw fail(409, 'Approving this category would exceed the supported category depth.');
        }
        created = await tx.category.create({ data: { name: item.name, slug, parentId } });
      } else if (item.kind === CatalogSuggestionKind.BRAND) {
        const existing = await tx.brand.findFirst({ where: { name: { equals: item.name, mode: 'insensitive' } }, select: { id: true } });
        if (existing) throw fail(409, 'A matching brand already exists. Resolve the duplicate and review this suggestion again.');
        let slug = slugBase(item.name);
        let suffix = 2;
        while (await tx.brand.findUnique({ where: { slug }, select: { id: true } })) slug = `${slugBase(item.name).slice(0, 130)}-${suffix++}`;
        created = await tx.brand.create({ data: { name: item.name, slug } });
      } else {
        const existing = await tx.catalogFeature.findFirst({ where: { name: { equals: item.name, mode: 'insensitive' }, categoryId: item.categoryId }, select: { id: true } });
        if (existing) throw fail(409, 'A matching feature already exists in this category. Resolve the duplicate and review this suggestion again.');
        let slug = slugBase(item.name);
        let suffix = 2;
        while (await tx.catalogFeature.findUnique({ where: { slug }, select: { id: true } })) slug = `${slugBase(item.name).slice(0, 130)}-${suffix++}`;
        created = await tx.catalogFeature.create({ data: { name: item.name, slug, categoryId: item.categoryId } });
      }
      const updated = await tx.catalogSuggestion.update({ where: { id: item.id }, data: { status: CatalogSuggestionStatus.APPROVED, reviewedById: admin.id, reviewedAt: new Date(), reviewNote: input.reviewNote ?? null } });
      return { created, updated };
    });
    await audit(admin.id, 'CATALOG_SUGGESTION_APPROVED', 'CatalogSuggestion', item.id, { kind: item.kind, name: item.name, catalogId: entity.created.id, reviewNote: entity.updated.reviewNote });
    res.json({ ...entity.updated, catalogItem: entity.created });
  }));
}
