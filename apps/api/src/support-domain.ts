export const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_BUYER', 'WAITING_ON_SELLER', 'RESOLVED', 'CLOSED'] as const;
export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const SUPPORT_ACTIVE_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_BUYER', 'WAITING_ON_SELLER'] as const;
export const SUPPORT_REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SupportActor = { id: string; role: string; sellerId?: string };
export type SupportTicketAccess = { buyerId: string; sellerId: string | null; status: string; resolvedAt: Date | null };

export function canAccessSupportTicket(ticket: SupportTicketAccess, actor: SupportActor): boolean {
  if (actor.role === 'ADMIN') return true;
  if (ticket.buyerId === actor.id) return true;
  return Boolean(ticket.sellerId && actor.sellerId && ticket.sellerId === actor.sellerId);
}

export function canReplyToSupportTicket(ticket: SupportTicketAccess, actor: SupportActor, now = Date.now()): boolean {
  if (!canAccessSupportTicket(ticket, actor) || ticket.status === 'CLOSED') return false;
  if (ticket.status !== 'RESOLVED') return true;
  const elapsed = ticket.resolvedAt ? now - ticket.resolvedAt.getTime() : -1;
  return actor.id === ticket.buyerId && elapsed >= 0 && elapsed <= SUPPORT_REOPEN_WINDOW_MS;
}

export function statusAfterSupportReply(currentStatus: string, actor: SupportActor): string {
  if (currentStatus === 'RESOLVED' && actor.role !== 'ADMIN') return 'OPEN';
  if (actor.role === 'ADMIN') return 'WAITING_ON_BUYER';
  if (actor.role === 'SELLER' || actor.role === 'CASHIER') return 'WAITING_ON_BUYER';
  return 'IN_PROGRESS';
}

export function canTransitionSupportStatus(current: string, next: string, actorRole: string, hasSeller: boolean): boolean {
  if (actorRole !== 'ADMIN' || !SUPPORT_STATUSES.includes(current as typeof SUPPORT_STATUSES[number]) || !SUPPORT_STATUSES.includes(next as typeof SUPPORT_STATUSES[number])) return false;
  if (current === next || current === 'CLOSED') return false;
  if (next === 'WAITING_ON_SELLER' && !hasSeller) return false;
  if (current === 'RESOLVED') return next === 'OPEN' || next === 'CLOSED';
  return true;
}
