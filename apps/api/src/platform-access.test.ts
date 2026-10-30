import { describe, expect, it } from 'vitest';
import { hasPlatformPermission, POSITION_DEFAULT_PERMISSIONS, requiredPlatformPermission } from './platform-access.js';

describe('platform collaborator permissions', () => {
  it('maps supported administration APIs to the assigned module scope', () => {
    expect(requiredPlatformPermission('GET', '/api/admin/orders')).toBe('MARKETPLACE');
    expect(requiredPlatformPermission('POST', '/api/admin/seller-commission-policies')).toBe('PAYMENTS');
    expect(requiredPlatformPermission('PATCH', '/api/admin/settings', { method: 'STRIPE' })).toBe('PAYMENTS');
    expect(requiredPlatformPermission('PATCH', '/api/admin/platform/settings', { sellerApprovalPolicy: 'MANUAL', reason: 'review' })).toBe('MARKETPLACE');
    expect(requiredPlatformPermission('PATCH', '/api/admin/platform/settings', { payoutHoldDays: 3, reason: 'review' })).toBe('PAYMENTS');
    expect(requiredPlatformPermission('PATCH', '/api/admin/platform/settings', { sellerApprovalPolicy: 'MANUAL', payoutHoldDays: 3, reason: 'review' })).toBeNull();
    expect(requiredPlatformPermission('POST', '/api/admin/campaigns')).toBe('GROWTH');
    expect(requiredPlatformPermission('GET', '/api/admin/club-coins/rules')).toBe('WALLET_MANAGEMENT');
    expect(requiredPlatformPermission('GET', '/api/admin/categories')).toBe('MARKETPLACE');
    expect(requiredPlatformPermission('PATCH', '/api/admin/integrations/payment-methods/STRIPE')).toBe('PAYMENTS');
    expect(requiredPlatformPermission('GET', '/api/admin/payment-settings')).toBe('PAYMENTS');
    expect(requiredPlatformPermission('GET', '/api/admin/settings')).toBeNull();
    expect(requiredPlatformPermission('GET', '/api/admin/store-email/status')).toBe('GROWTH');
    expect(requiredPlatformPermission('GET', '/api/admin/store-email/providers')).toBe('INTEGRATIONS');
    expect(requiredPlatformPermission('PATCH', '/api/admin/content/posts/post-1')).toBe('CONTENT_MANAGEMENT');
  });

  it('does not grant team-management or unknown routes to collaborators', () => {
    expect(requiredPlatformPermission('GET', '/api/admin/collaborators')).toBeNull();
    expect(requiredPlatformPermission('POST', '/api/admin/collaborator-positions')).toBeNull();
    expect(requiredPlatformPermission('PATCH', '/api/admin/collaborator-positions/custom-position')).toBeNull();
    expect(requiredPlatformPermission('DELETE', '/api/admin/secret-operation')).toBeNull();
    expect(hasPlatformPermission(['MARKETPLACE'], null)).toBe(false);
    expect(hasPlatformPermission(['MARKETPLACE'], 'PAYMENTS')).toBe(false);
  });

  it('provides useful least-privilege position defaults without overriding editable grants', () => {
    expect(POSITION_DEFAULT_PERMISSIONS.ACCOUNTANT).toEqual(['OVERVIEW', 'PLANS_BILLING', 'PAYMENTS']);
    expect(POSITION_DEFAULT_PERMISSIONS.WRITER).toEqual(['CONTENT_MANAGEMENT']);
    expect(POSITION_DEFAULT_PERMISSIONS.EDITOR).toEqual(['CONTENT_MANAGEMENT']);
  });
});
