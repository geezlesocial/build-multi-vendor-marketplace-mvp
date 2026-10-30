import type { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { requireRole } from './security.js';

function invokeStaffRoleGate(user: Record<string, unknown>, method: string, path: string) {
  const next = vi.fn() as unknown as NextFunction;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const req = { method, path, body: {} } as Request;
  const res = { locals: { user }, status, json } as unknown as Response;
  requireRole(Role.ADMIN)(req, res, next);
  return { next, status, json };
}

describe('platform staff API authorization', () => {
  const verifiedMarketplaceStaff = { id: 'staff-1', role: Role.PLATFORM_STAFF, emailVerifiedAt: new Date(), platformPermissions: ['MARKETPLACE'] };

  it('allows verified collaborators only within a granted API scope', () => {
    expect(invokeStaffRoleGate(verifiedMarketplaceStaff, 'GET', '/api/admin/orders').next).toHaveBeenCalledOnce();
    const denied = invokeStaffRoleGate(verifiedMarketplaceStaff, 'GET', '/api/admin/payment-settings');
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.status).toHaveBeenCalledWith(403);
  });

  it('requires verified email and never delegates collaborator management', () => {
    const unverified = invokeStaffRoleGate({ ...verifiedMarketplaceStaff, emailVerifiedAt: null }, 'GET', '/api/admin/orders');
    expect(unverified.next).not.toHaveBeenCalled();
    expect(unverified.status).toHaveBeenCalledWith(403);
    const teamManagement = invokeStaffRoleGate({ ...verifiedMarketplaceStaff, platformPermissions: ['ADMINISTRATOR'] }, 'POST', '/api/admin/collaborators');
    expect(teamManagement.next).not.toHaveBeenCalled();
    expect(teamManagement.status).toHaveBeenCalledWith(403);
  });

  it('returns only assigned marketplace or payment policy groups', () => {
    expect(invokeStaffRoleGate(verifiedMarketplaceStaff, 'GET', '/api/admin/platform/settings').next).toHaveBeenCalledOnce();
    const noPolicyScope = invokeStaffRoleGate({ ...verifiedMarketplaceStaff, platformPermissions: ['PLATFORM_SETTINGS'] }, 'GET', '/api/admin/platform/settings');
    expect(noPolicyScope.next).toHaveBeenCalledOnce();
  });
});
