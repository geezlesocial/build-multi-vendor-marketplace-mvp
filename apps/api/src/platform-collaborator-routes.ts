import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { Prisma, Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createAccountVerificationChallenge, deliverAccountVerification } from './account-verification-routes.js';
import { createRoleNotifications, createUserNotification } from './notification-delivery.js';
import { PLATFORM_PERMISSIONS, PLATFORM_POSITIONS, PLATFORM_POSITION_LABELS, POSITION_DEFAULT_PERMISSIONS } from './platform-access.js';
import { hashPassword, prisma, requireAuth, requireRole } from './security.js';

const run = (handler: (req: Request, res: Response, next: NextFunction) => unknown): express.RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const actor = (res: Response) => res.locals.user as { id: string; role: Role };
const safePermissionInput = z.array(z.enum(PLATFORM_PERMISSIONS)).max(PLATFORM_PERMISSIONS.length).refine(items => new Set(items).size === items.length, 'Permission values must be unique.');
const safePositionPermissions = safePermissionInput.min(1, 'Choose at least one access permission.');
const reasonSchema = z.string().trim().min(8).max(500);
const customPositionName = z.string().trim().min(2).max(48).regex(/^[\p{L}\p{N}][\p{L}\p{N} .&'’()-]*$/u, 'Use letters, numbers, spaces, and basic punctuation for a position name.');
const isBuiltInPosition = (position: string): position is keyof typeof POSITION_DEFAULT_PERMISSIONS => (PLATFORM_POSITIONS as readonly string[]).includes(position);
const positionNameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const reservedPositionNames = new Set([...Object.values(PLATFORM_POSITION_LABELS), ...PLATFORM_POSITIONS].map(positionNameKey));

const collaboratorInclude = {
  user: { select: { id: true, name: true, email: true, accountStatus: true, emailVerifiedAt: true, createdAt: true } },
  createdBy: { select: { id: true, name: true, email: true } }
} satisfies Prisma.PlatformCollaboratorInclude;

export function registerPlatformCollaboratorRoutes(app: Express) {
  app.get('/api/admin/collaborator-positions', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const custom = await prisma.platformTeamPosition.findMany({ orderBy: [{ enabled: 'desc' }, { name: 'asc' }] });
    const builtIn = PLATFORM_POSITIONS.map(key => ({ key, name: PLATFORM_POSITION_LABELS[key], permissions: POSITION_DEFAULT_PERMISSIONS[key], enabled: true, builtIn: true }));
    res.json({ positions: [...builtIn, ...custom.map(item => ({ key: item.id, name: item.name, permissions: item.permissions, enabled: item.enabled, builtIn: false }))] });
  }));

  app.post('/api/admin/collaborator-positions', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({ name: customPositionName, permissions: safePositionPermissions, reason: reasonSchema }).strict().parse(req.body);
    const name = input.name.replace(/\s+/g, ' ');
    if (reservedPositionNames.has(positionNameKey(name))) throw fail(409, 'That name is reserved for a built-in team position.');
    const id = `CUSTOM_${randomBytes(12).toString('hex')}`;
    try {
      const position = await prisma.$transaction(async tx => {
        const nameNormalized = positionNameKey(name);
        const duplicate = await tx.platformTeamPosition.findUnique({ where: { nameNormalized }, select: { id: true } });
        if (duplicate) throw fail(409, 'A team position with that name already exists.');
        const created = await tx.platformTeamPosition.create({ data: { id, name, nameNormalized, permissions: input.permissions, createdById: admin.id } });
        await tx.auditLog.create({ data: { actorId: admin.id, action: 'PLATFORM_TEAM_POSITION_CREATED', entity: 'PlatformTeamPosition', entityId: created.id, metadata: {
          name: created.name,
          permissions: created.permissions,
          reason: input.reason
        } } });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      res.status(201).json({ position: { key: position.id, name: position.name, permissions: position.permissions, enabled: position.enabled, builtIn: false } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'A team position with that name already exists.');
      throw error;
    }
  }));

  app.patch('/api/admin/collaborator-positions/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const id = param(req.params.id);
    const input = z.object({ name: customPositionName.optional(), permissions: safePositionPermissions.optional(), enabled: z.boolean().optional(), reason: reasonSchema }).strict()
      .refine(value => value.name !== undefined || value.permissions !== undefined || value.enabled !== undefined, 'Provide at least one position change.').parse(req.body);
    try {
      const position = await prisma.$transaction(async tx => {
        const current = await tx.platformTeamPosition.findUnique({ where: { id } });
        if (!current) throw fail(404, 'Custom team position not found.');
        const name = input.name?.replace(/\s+/g, ' ');
        if (name && reservedPositionNames.has(positionNameKey(name))) throw fail(409, 'That name is reserved for a built-in team position.');
        const nameNormalized = name ? positionNameKey(name) : current.nameNormalized;
        if (name && nameNormalized !== current.nameNormalized) {
          const duplicate = await tx.platformTeamPosition.findUnique({ where: { nameNormalized }, select: { id: true } });
          if (duplicate && duplicate.id !== id) throw fail(409, 'A team position with that name already exists.');
        }
        if (input.enabled === false && current.enabled) {
          const assigned = await tx.platformCollaborator.count({ where: { position: id } });
          if (assigned > 0) throw fail(409, 'Reassign team members before archiving this position.');
        }
        const updated = await tx.platformTeamPosition.update({ where: { id }, data: { name, nameNormalized, permissions: input.permissions, enabled: input.enabled } });
        await tx.auditLog.create({ data: { actorId: admin.id, action: updated.enabled ? 'PLATFORM_TEAM_POSITION_UPDATED' : 'PLATFORM_TEAM_POSITION_ARCHIVED', entity: 'PlatformTeamPosition', entityId: updated.id, metadata: {
          previousName: current.name,
          name: updated.name,
          previousPermissions: current.permissions,
          permissions: updated.permissions,
          previousEnabled: current.enabled,
          enabled: updated.enabled,
          reason: input.reason
        } } });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      res.json({ position: { key: position.id, name: position.name, permissions: position.permissions, enabled: position.enabled, builtIn: false } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'A team position with that name already exists.');
      throw error;
    }
  }));

  app.get('/api/admin/collaborators', requireAuth, requireRole(Role.ADMIN), run(async (_req, res) => {
    const items = await prisma.platformCollaborator.findMany({ include: collaboratorInclude, orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }] });
    res.json({ items });
  }));

  app.post('/api/admin/collaborators', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const input = z.object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().email().max(254),
      password: z.string().min(12).max(72),
      position: z.string().min(1).max(32),
      permissions: safePermissionInput,
      reason: reasonSchema
    }).strict().parse(req.body);
    const email = input.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw fail(409, 'An account with this email already exists. Collaborator creation does not change existing account roles.');
    const passwordHash = await hashPassword(input.password);
    let created: { id: string; name: string; email: string; role: Role };
    try {
      created = await prisma.$transaction(async tx => {
        if (!isBuiltInPosition(input.position)) {
          const availablePosition = await tx.platformTeamPosition.findFirst({ where: { id: input.position, enabled: true }, select: { id: true } });
          if (!availablePosition) throw fail(400, 'Choose an available team position.');
        }
        const user = await tx.user.create({ data: {
          email,
          name: input.name,
          passwordHash,
          role: Role.PLATFORM_STAFF,
          onboardingCompletedAt: new Date()
        }, select: { id: true, name: true, email: true, role: true } });
        await tx.platformCollaborator.create({ data: {
          userId: user.id,
          position: input.position,
          permissions: input.permissions,
          createdById: admin.id
        } });
        await tx.auditLog.create({ data: { actorId: admin.id, action: 'PLATFORM_COLLABORATOR_CREATED', entity: 'User', entityId: user.id, metadata: {
          email,
          position: input.position,
          permissions: input.permissions,
          reason: input.reason,
          initialPasswordSet: true,
          emailVerificationRequired: true
        } } });
        await createUserNotification(tx, { userId: user.id, eventType: 'PLATFORM_COLLABORATOR_CREATED', title: 'Platform team account created', body: 'An administrator created your team account. Verify your email before opening your assigned workspace.', link: '/admin/platform', payloadJson: { position: input.position } }, 'account');
        await createRoleNotifications(tx, Role.ADMIN, { eventType: 'PLATFORM_COLLABORATOR_CREATED', title: 'Platform collaborator added', body: `${user.name} was added to the platform team as ${input.position.toLowerCase().replaceAll('_', ' ')}.`, link: '/admin/platform?section=team', payloadJson: { userId: user.id, position: input.position } }, 'account', [admin.id]);
        return user;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'An account with this email already exists.');
      throw error;
    }
    const challenge = await createAccountVerificationChallenge(created.id);
    const verification = await deliverAccountVerification(challenge);
    res.status(201).json({ collaborator: await prisma.platformCollaborator.findUnique({ where: { userId: created.id }, include: collaboratorInclude }), verificationEmailSent: verification.sent });
  }));

  app.patch('/api/admin/collaborators/:id', requireAuth, requireRole(Role.ADMIN), run(async (req, res) => {
    const admin = actor(res);
    const id = param(req.params.id);
    const input = z.object({
      name: z.string().trim().min(2).max(100).optional(),
      position: z.string().min(1).max(32).optional(),
      permissions: safePermissionInput.optional(),
      enabled: z.boolean().optional(),
      reason: reasonSchema
    }).strict().refine(value => value.name !== undefined || value.position !== undefined || value.permissions !== undefined || value.enabled !== undefined, 'Provide at least one collaborator change.').parse(req.body);
    const result = await prisma.$transaction(async tx => {
      const current = await tx.platformCollaborator.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true, accountStatus: true } } } });
      if (!current) throw fail(404, 'Platform collaborator not found.');
      if (input.position && !isBuiltInPosition(input.position)) {
        const availablePosition = await tx.platformTeamPosition.findFirst({ where: { id: input.position, enabled: true }, select: { id: true } });
        if (!availablePosition) throw fail(400, 'Choose an available team position.');
      }
      const permissionChanged = input.permissions !== undefined && (input.permissions.length !== current.permissions.length || input.permissions.some(permission => !current.permissions.includes(permission)));
      const enabledChanged = input.enabled !== undefined && input.enabled !== current.enabled;
      const updated = await tx.platformCollaborator.update({ where: { id }, data: {
        position: input.position,
        permissions: input.permissions,
        enabled: input.enabled,
        user: { update: { ...(input.name !== undefined ? { name: input.name } : {}), ...(enabledChanged ? { accountStatus: input.enabled ? 'ACTIVE' : 'SUSPENDED' } : {}) } }
      } });
      const revoked = permissionChanged || (enabledChanged && input.enabled === false)
        ? await tx.session.deleteMany({ where: { userId: current.userId } })
        : { count: 0 };
      await tx.auditLog.create({ data: { actorId: admin.id, action: enabledChanged ? (input.enabled ? 'PLATFORM_COLLABORATOR_REACTIVATED' : 'PLATFORM_COLLABORATOR_DEACTIVATED') : 'PLATFORM_COLLABORATOR_UPDATED', entity: 'User', entityId: current.userId, metadata: {
        email: current.user.email,
        previousPosition: current.position,
        position: updated.position,
        previousPermissions: current.permissions,
        permissions: updated.permissions,
        previousEnabled: current.enabled,
        enabled: updated.enabled,
        sessionsRevoked: revoked.count,
        reason: input.reason
      } } });
      return { updated, sessionsRevoked: revoked.count };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ collaborator: await prisma.platformCollaborator.findUnique({ where: { id: result.updated.id }, include: collaboratorInclude }), sessionsRevoked: result.sessionsRevoked });
  }));
}
