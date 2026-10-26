export type MemberStatus = 'ACTIVE' | 'SUSPENDED';
export const SELLER_ACCOUNT_SUSPENSION_REASON = 'Owner account suspended by a platform administrator.';

export function memberStatusChangeFailure(input: {
  actorId: string; targetId: string; targetRole: string; currentStatus: string; nextStatus: MemberStatus; activeAdminCount: number;
}): string | null {
  if (input.actorId === input.targetId && input.nextStatus === 'SUSPENDED') return 'Administrators cannot suspend their own account.';
  if (input.currentStatus === input.nextStatus) return `This account is already ${input.currentStatus.toLowerCase()}.`;
  if (input.targetRole === 'ADMIN' && input.currentStatus === 'ACTIVE' && input.nextStatus === 'SUSPENDED' && input.activeAdminCount <= 1) return 'The last active administrator cannot be suspended.';
  return null;
}

export function canRestoreSellerAfterAccountReactivation(input: { sellerStatus: string; sellerReason: string | null; previousStatus: string | null }): boolean {
  return input.sellerStatus === 'SUSPENDED' && input.sellerReason === SELLER_ACCOUNT_SUSPENSION_REASON && input.previousStatus === 'APPROVED';
}
