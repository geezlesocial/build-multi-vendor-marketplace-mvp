import { describe, expect, it } from 'vitest';
import { canAccessSupportTicket, canReplyToSupportTicket, canTransitionSupportStatus, statusAfterSupportReply } from './support-domain.js';

const ticket = { buyerId: 'buyer-1', sellerId: 'seller-1', status: 'OPEN', resolvedAt: null as Date | null };
const buyer = { id: 'buyer-1', role: 'BUYER' };
const seller = { id: 'seller-user', role: 'SELLER', sellerId: 'seller-1' };
const admin = { id: 'admin-1', role: 'ADMIN' };

describe('support ticket access and lifecycle', () => {
  it('limits a ticket to its buyer, assigned seller, or administrator', () => {
    expect(canAccessSupportTicket(ticket, buyer)).toBe(true);
    expect(canAccessSupportTicket(ticket, seller)).toBe(true);
    expect(canAccessSupportTicket(ticket, admin)).toBe(true);
    expect(canAccessSupportTicket(ticket, { id: 'other', role: 'BUYER' })).toBe(false);
    expect(canAccessSupportTicket({ ...ticket, sellerId: null }, seller)).toBe(false);
  });

  it('allows only the buyer to reopen a resolved ticket within seven days', () => {
    const resolved = { ...ticket, status: 'RESOLVED', resolvedAt: new Date(1_000_000) };
    expect(canReplyToSupportTicket(resolved, buyer, 1_000_000 + 6 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(canReplyToSupportTicket(resolved, buyer, 1_000_000 + 8 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(canReplyToSupportTicket(resolved, seller, 1_000_000)).toBe(false);
    expect(statusAfterSupportReply('RESOLVED', buyer)).toBe('OPEN');
  });

  it('keeps closed tickets terminal and restricts status changes to admins', () => {
    expect(canReplyToSupportTicket({ ...ticket, status: 'CLOSED' }, admin)).toBe(false);
    expect(canTransitionSupportStatus('OPEN', 'IN_PROGRESS', 'ADMIN', false)).toBe(true);
    expect(canTransitionSupportStatus('OPEN', 'WAITING_ON_SELLER', 'ADMIN', false)).toBe(false);
    expect(canTransitionSupportStatus('OPEN', 'RESOLVED', 'BUYER', true)).toBe(false);
    expect(canTransitionSupportStatus('CLOSED', 'OPEN', 'ADMIN', true)).toBe(false);
  });
});
