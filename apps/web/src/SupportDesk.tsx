import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './SupportDesk.css';

type Mode = 'buyer' | 'seller' | 'admin';
type SupportMessage = { id: string; authorId: string; authorName: string; authorRole: string; body: string; createdAt: string };
type SupportTicket = {
  id: string; ticketNumber: string; buyerId: string; buyerName: string; sellerId: string | null; storeName: string | null;
  parentOrderId: string | null; orderNumber: string | null; sellerOrderId: string | null; subject: string; category: string;
  status: string; priority: string; assignedAdminId: string | null; assignedAdminName: string | null;
  createdAt: string; updatedAt: string; resolvedAt: string | null; lastMessage: string | null; lastMessageAt: string | null;
  lastMessageAuthorRole: string | null; messageCount: number; messages?: SupportMessage[];
};

const statuses = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_BUYER', 'WAITING_ON_SELLER', 'RESOLVED', 'CLOSED'];
const statusLabel = (value: string) => value.replaceAll('_', ' ').toLocaleLowerCase().replace(/(^|\s)\S/g, char => char.toLocaleUpperCase());

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? 'Support request failed.'); }
  return response.status === 204 ? undefined as T : response.json();
}

export function SupportDesk({ mode, orders = [] }: { mode: Mode; orders?: any[] }) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<SupportTicket | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState('');
  const [form, setForm] = useState({ subject: '', category: 'ORDER', sellerOrderId: '', body: '' });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const query = mode === 'admin' && filter !== 'ALL' ? `?status=${encodeURIComponent(filter)}` : '';
      const data = await api<{ tickets: SupportTicket[] }>(`/api/support/tickets${query}`);
      setTickets(data.tickets);
      setError('');
      if (!selectedId && data.tickets[0]) setSelectedId(data.tickets[0].id);
      if (selectedId && !data.tickets.some(ticket => ticket.id === selectedId)) setSelectedId(data.tickets[0]?.id ?? '');
    } catch (cause) { setError((cause as Error).message); }
    finally { if (!quiet) setLoading(false); }
  }, [filter, mode, selectedId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    const refreshDetail = async () => {
      try { const next = await api<SupportTicket>(`/api/support/tickets/${encodeURIComponent(selectedId)}`); if (active) setDetail(next); }
      catch (cause) { if (active) setError((cause as Error).message); }
    };
    void refreshDetail();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshDetail(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedId]);

  const orderOptions = useMemo(() => orders.flatMap(order => (order.sellerOrders ?? []).map((sellerOrder: any) => ({
    id: sellerOrder.id, label: `${order.orderNumber} · ${sellerOrder.seller?.store?.name ?? 'Store'}`
  }))), [orders]);
  const availableStatusOptions = detail?.status === 'CLOSED' ? ['CLOSED'] : detail?.status === 'RESOLVED' ? ['RESOLVED', 'OPEN', 'CLOSED'] : statuses;

  const createTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setCreating(true); setError(''); setNotice('');
    try {
      const ticket = await api<SupportTicket>('/api/support/tickets', { method: 'POST', body: JSON.stringify({ ...form, sellerOrderId: form.sellerOrderId || undefined }) });
      setForm({ subject: '', category: 'ORDER', sellerOrderId: '', body: '' });
      setSelectedId(ticket.id); setDetail(ticket); setNotice(`Support request ${ticket.ticketNumber} created.`); await load(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setCreating(false); }
  };

  const sendReply = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail || !reply.trim()) return;
    setSending(true); setError(''); setNotice('');
    try {
      const updated = await api<SupportTicket>(`/api/support/tickets/${encodeURIComponent(detail.id)}/messages`, { method: 'POST', body: JSON.stringify({ body: reply }) });
      setDetail(updated); setReply(''); setNotice('Reply sent.'); await load(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSending(false); }
  };

  const updateAdmin = async (changes: Record<string, unknown>) => {
    if (!detail) return;
    setError(''); setNotice('');
    try {
      const updated = await api<SupportTicket>(`/api/support/tickets/${encodeURIComponent(detail.id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
      setDetail(updated); setNotice('Ticket updated.'); await load(true);
    } catch (cause) { setError((cause as Error).message); }
  };

  return <section className="supportDesk" aria-labelledby="support-heading">
    <header className="supportDeskHeader">
      <div><p className="eyebrow">{mode === 'admin' ? 'Customer operations' : 'Help center'}</p><h2 id="support-heading">{mode === 'admin' ? 'Support inbox' : 'Support requests'}</h2>
        <p className="muted">{mode === 'admin' ? 'Review member requests and coordinate order-related help.' : 'Keep order and account questions in one tracked, private thread.'}</p></div>
      {mode === 'admin' && <label className="supportFilter">Status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="ALL">All tickets</option>{statuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label>}
    </header>
    {notice && <p className="supportNotice" role="status">{notice}</p>}{error && <p className="supportError" role="alert">{error}</p>}
    <div className={`supportDeskLayout supportDesk-${mode}`}>
      <div className="supportDeskRail">
        {mode === 'buyer' && <form className="supportCreate card cardBody" onSubmit={event => void createTicket(event)}>
          <h3>Open a request</h3>
          <label>Topic<select value={form.category} onChange={event => setForm(current => ({ ...current, category: event.target.value }))}><option value="ORDER">Order question</option><option value="DELIVERY">Delivery</option><option value="PAYMENT">Payment</option><option value="PRODUCT">Product</option><option value="ACCOUNT">Account</option><option value="OTHER">Other</option></select></label>
          {orderOptions.length > 0 && <label>Related order (optional)<select value={form.sellerOrderId} onChange={event => setForm(current => ({ ...current, sellerOrderId: event.target.value }))}><option value="">General marketplace support</option>{orderOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
          <label>Subject<input required minLength={5} maxLength={140} value={form.subject} onChange={event => setForm(current => ({ ...current, subject: event.target.value }))} /></label>
          <label>How can we help?<textarea required maxLength={4000} rows={4} value={form.body} onChange={event => setForm(current => ({ ...current, body: event.target.value }))} /></label>
          <button className="primary" disabled={creating}>{creating ? 'Opening…' : 'Send support request'}</button>
        </form>}
        <div className="supportTicketList" aria-label="Support tickets">
          {loading && <div className="empty">Loading support requests…</div>}
          {!loading && !tickets.length && <div className="empty">{mode === 'seller' ? 'No order-related support requests for your Store.' : mode === 'admin' ? 'No tickets match this filter.' : 'Your support history will appear here.'}</div>}
          {tickets.map(ticket => <button type="button" key={ticket.id} className={`supportTicketRow ${selectedId === ticket.id ? 'selected' : ''}`} onClick={() => setSelectedId(ticket.id)}>
            <span className="supportTicketRowTop"><strong>{ticket.ticketNumber}</strong><span className={`supportStatus status-${ticket.status.toLowerCase()}`}>{statusLabel(ticket.status)}</span></span>
            <strong className="supportTicketSubject">{ticket.subject}</strong>
            <span className="supportTicketPreview">{mode === 'admin' ? `${ticket.buyerName} · ` : ''}{ticket.lastMessage ?? 'No replies yet'}</span>
            <span className="supportTicketMeta">{ticket.storeName ? `${ticket.storeName} · ` : ''}{ticket.messageCount} messages · {new Date(ticket.updatedAt).toLocaleString()}</span>
          </button>)}
        </div>
      </div>
      <article className="supportThread card cardBody">
        {!detail ? <div className="empty">Select a support request to view its conversation.</div> : <>
          <header className="supportThreadHeader"><div><p className="eyebrow">{detail.ticketNumber} · {detail.category}</p><h3>{detail.subject}</h3><p className="muted">{detail.orderNumber ? `Order ${detail.orderNumber}` : 'Marketplace support'}{detail.storeName ? ` · ${detail.storeName}` : ''}</p></div><div className="supportThreadStatus"><span className={`supportStatus status-${detail.status.toLowerCase()}`}>{statusLabel(detail.status)}</span>{mode === 'admin' && <span className="supportPriority">{detail.priority} priority</span>}</div></header>
          {mode === 'admin' && <div className="supportAdminControls"><label>Status<select value={detail.status} disabled={detail.status === 'CLOSED'} onChange={event => void updateAdmin({ status: event.target.value })}>{availableStatusOptions.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></label><label>Priority<select value={detail.priority} onChange={event => void updateAdmin({ priority: event.target.value })}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map(priority => <option key={priority} value={priority}>{statusLabel(priority)}</option>)}</select></label><button type="button" onClick={() => void updateAdmin({ assignToMe: true })}>{detail.assignedAdminName ? `Assigned: ${detail.assignedAdminName}` : 'Assign to me'}</button></div>}
          {detail.messageCount > (detail.messages?.length ?? 0) && <p className="muted">Showing the latest {detail.messages?.length ?? 0} messages.</p>}
          <ol className="supportMessages" aria-label="Support conversation">{detail.messages?.map(message => <li key={message.id} className={`supportMessage ${message.authorRole.toLowerCase()} ${message.authorId === detail.buyerId ? 'fromBuyer' : ''}`}>
            <div className="supportMessageByline"><strong>{message.authorName}</strong><span>{statusLabel(message.authorRole)}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div><p>{message.body}</p>
          </li>)}</ol>
          {detail.status !== 'CLOSED' && <form className="supportReply" onSubmit={event => void sendReply(event)}><label htmlFor={`support-reply-${detail.id}`}>Reply to this request</label><textarea id={`support-reply-${detail.id}`} rows={3} maxLength={4000} value={reply} onChange={event => setReply(event.target.value)} placeholder="Write a clear update for the participants…" /><button className="primary" disabled={sending || !reply.trim()}>{sending ? 'Sending…' : 'Send reply'}</button></form>}
          {detail.status === 'RESOLVED' && <p className="muted">If the issue is still unresolved, the buyer can reply within seven days to reopen this ticket.</p>}
          {detail.status === 'CLOSED' && <p className="muted">This ticket is closed. Contact support to open a new request if you still need help.</p>}
        </>}
      </article>
    </div>
  </section>;
}
