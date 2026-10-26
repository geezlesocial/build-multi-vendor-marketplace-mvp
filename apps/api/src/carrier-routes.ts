import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma, requireAuth, requireRole } from './security.js';
import { isSafeTrackingUrlTemplate } from './carrier-domain.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const reason = z.string().trim().min(3).max(500);
const carrierFields = {
  name: z.string().trim().min(2).max(120),
  countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/).transform(value => value.toUpperCase())).max(100).default([]),
  trackingUrlTemplate: z.preprocess(value => typeof value === 'string' && !value.trim() ? null : value, z.string().trim().max(500).nullable()).refine(value => value === null || isSafeTrackingUrlTemplate(value), 'Tracking page must be a safe HTTPS URL. Use {trackingNumber} only when the provider supports it.'),
  enabled: z.boolean().default(true)
};
const createSchema = z.object({ code: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), ...carrierFields, reason }).strict();
const updateSchema = z.object({
  name: carrierFields.name.optional(),
  countries: carrierFields.countries.optional(),
  trackingUrlTemplate: carrierFields.trackingUrlTemplate.optional(),
  enabled: carrierFields.enabled.optional(),
  reason
}).strict().refine(input => Object.keys(input).some(key => key !== 'reason'), 'Provide at least one carrier field to update.');

async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, carrierId: string, metadata: unknown) {
  await tx.auditLog.create({ data: { actorId, action, entity: 'ShippingCarrierProvider', entityId: carrierId, metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue } });
}

export function registerCarrierRoutes(app: Express) {
  app.get('/api/admin/shipping/carriers', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const carriers = await prisma.shippingCarrierProvider.findMany({ include: { _count: { select: { services: true } } }, orderBy: [{ enabled: 'desc' }, { name: 'asc' }] });
    res.json(carriers);
  }));

  app.post('/api/admin/shipping/carriers', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const actor = res.locals.user as { id: string };
    const input = createSchema.parse(req.body);
    try {
      const carrier = await prisma.$transaction(async tx => {
        const created = await tx.shippingCarrierProvider.create({ data: { code: input.code, name: input.name, countries: input.countries, trackingUrlTemplate: input.trackingUrlTemplate, enabled: input.enabled, createdById: actor.id, updatedById: actor.id } });
        await audit(tx, actor.id, 'SHIPPING_CARRIER_CREATED', created.id, { code: created.code, name: created.name, countries: created.countries, enabled: created.enabled, reason: input.reason });
        return created;
      });
      res.status(201).json(carrier);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'A carrier with this code already exists.');
      throw error;
    }
  }));

  app.patch('/api/admin/shipping/carriers/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const actor = res.locals.user as { id: string };
    const id = param(req.params.id);
    const input = updateSchema.parse(req.body);
    const current = await prisma.shippingCarrierProvider.findUnique({ where: { id } });
    if (!current) throw fail(404, 'Shipping carrier not found.');
    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.countries !== undefined ? { countries: input.countries } : {}),
      ...(input.trackingUrlTemplate !== undefined ? { trackingUrlTemplate: input.trackingUrlTemplate } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedById: actor.id
    };
    const carrier = await prisma.$transaction(async tx => {
      const updated = await tx.shippingCarrierProvider.update({ where: { id }, data });
      await audit(tx, actor.id, 'SHIPPING_CARRIER_UPDATED', id, {
        changedFields: Object.keys(data).filter(key => key !== 'updatedById'),
        oldEnabled: current.enabled, newEnabled: updated.enabled,
        reason: input.reason
      });
      return updated;
    });
    res.json(carrier);
  }));
}
