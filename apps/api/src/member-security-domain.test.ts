import { describe, expect, it } from 'vitest';
import { canRestoreSellerAfterAccountReactivation, memberStatusChangeFailure, SELLER_ACCOUNT_SUSPENSION_REASON } from './member-security-domain.js';

describe('admin member security controls', () => {
  it('prevents self-suspension and suspension of the last active administrator', () => {
    expect(memberStatusChangeFailure({ actorId: 'admin-1', targetId: 'admin-1', targetRole: 'ADMIN', currentStatus: 'ACTIVE', nextStatus: 'SUSPENDED', activeAdminCount: 2 })).toMatch(/own account/i);
    expect(memberStatusChangeFailure({ actorId: 'admin-1', targetId: 'admin-2', targetRole: 'ADMIN', currentStatus: 'ACTIVE', nextStatus: 'SUSPENDED', activeAdminCount: 1 })).toMatch(/last active administrator/i);
  });

  it('rejects no-op status changes but allows safe reactivation', () => {
    expect(memberStatusChangeFailure({ actorId: 'admin-1', targetId: 'buyer-1', targetRole: 'BUYER', currentStatus: 'ACTIVE', nextStatus: 'ACTIVE', activeAdminCount: 2 })).toMatch(/already active/i);
    expect(memberStatusChangeFailure({ actorId: 'admin-1', targetId: 'buyer-1', targetRole: 'BUYER', currentStatus: 'SUSPENDED', nextStatus: 'ACTIVE', activeAdminCount: 2 })).toBeNull();
  });

  it('restores only a seller that this account suspension actually paused', () => {
    expect(canRestoreSellerAfterAccountReactivation({ sellerStatus: 'SUSPENDED', sellerReason: SELLER_ACCOUNT_SUSPENSION_REASON, previousStatus: 'APPROVED' })).toBe(true);
    expect(canRestoreSellerAfterAccountReactivation({ sellerStatus: 'SUSPENDED', sellerReason: 'Policy review', previousStatus: 'APPROVED' })).toBe(false);
    expect(canRestoreSellerAfterAccountReactivation({ sellerStatus: 'PENDING', sellerReason: null, previousStatus: 'PENDING' })).toBe(false);
  });
});
