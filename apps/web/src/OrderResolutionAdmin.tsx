import { useCallback, useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import './OrderResolution.css';

type RefundEvent = { id: string; provider: 'STRIPE' | 'PAYPAL'; eventId: string; eventType: string | null; amountMinor: number | null; currency: string | null; receivedAt: string };
type CaseMessage = { id: string; authorId: string; authorName: string | null; authorRole: string; body: string; createdAt: string };
type ResolutionCase = {
  id: string; parentOrderId: string; sellerOrderId: string; buyerId: string; sellerId: string | null; type: string; status: string; reason: string; description: string;
  approvedAmountMinor: number | null; resolutionNote: string | null; providerWebhookEventRowId: string | null; manualRefundReference: string | null; settledAt: string | null;
  orderNumber: string; currency: string; parentTotalMinor: number; sellerOrderTotalMinor: number; paymentMethod: string | null; paymentStatus: string | null;
  storeName: string | null; buyerName: string; createdAt: string; messages: CaseMessage[]; providerRefundEvents: RefundEvent[];
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}

const openStatuses = ['OPEN', 'UNDER_REVIEW'];
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, char => char.toUpperCase());

export function OrderResolutionAdmin() {
  const [cases, setCases] = useState<ResolutionCase[]>([]);
  const [filter, setFilter] = useState('OPEN');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { amount: string; note: string; reply: string; refundEvidence: string }>>({});
  const [events, setEvents] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { const rows = await api<ResolutionCase[]>('/api/admin/order-resolution-cases'); setCases(rows); setError(''); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000); return () => window.clearInterval(timer); }, [load]);

  const draft = (item: ResolutionCase) => drafts[item.id] ?? { amount: String(item.sellerOrderTotalMinor), note: '', reply: '', refundEvidence: '' };
  const runAction = async (id: string, operation: () => Promise<unknown>, success: string) => {
    setBusyId(id); setNotice('');
    try { await operation(); setNotice(success); await load(); }
    catch (cause) { setNotice((cause as Error).message); }
    finally { setBusyId(''); }
  };
  const sendReply = (item: ResolutionCase) => runAction(item.id, () => api(`/api/order-resolution-cases/${encodeURIComponent(item.id)}/messages`, { method: 'POST', body: JSON.stringify({ body: draft(item).reply }) }), 'Administrative update sent.');
  const decide = (item: ResolutionCase, outcome: 'APPROVE_REFUND' | 'REJECT' | 'RESOLVE_NO_REFUND') => {
    const current = draft(item);
    if (!current.note.trim()) { setNotice('Add an administrative decision note before resolving a case.'); return; }
    const approvedAmountMinor = Number(current.amount);
    if (outcome === 'APPROVE_REFUND' && (!Number.isSafeInteger(approvedAmountMinor) || approvedAmountMinor < 1)) { setNotice('Enter a valid refund amount in minor units.'); return; }
    const actionLabel = outcome === 'APPROVE_REFUND' ? 'approve this refund' : outcome === 'REJECT' ? 'reject this case' : 'close this case without a refund';
    if (!window.confirm(`Confirm you want to ${actionLabel}? This action will be recorded in the audit log.`)) return;
    void runAction(item.id, () => api(`/api/admin/order-resolution-cases/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body: JSON.stringify({ outcome, ...(outcome === 'APPROVE_REFUND' ? { approvedAmountMinor } : {}), note: current.note }) }), outcome === 'APPROVE_REFUND' ? 'Refund approved. It remains blocked pending verified settlement evidence.' : 'Case decision saved.');
  };
  const settle = (item: ResolutionCase) => {
    const evidence = draft(item).refundEvidence.trim();
    if (item.paymentMethod === 'COD') {
      if (!evidence) { setNotice('Enter the off-platform COD repayment reference.'); return; }
      void runAction(item.id, () => api(`/api/admin/order-resolution-cases/${encodeURIComponent(item.id)}/settle-refund`, { method: 'POST', body: JSON.stringify({ manualRefundReference: evidence }) }), 'COD repayment evidence recorded.');
      return;
    }
    const selected = item.providerRefundEvents.find(event => `${event.provider}:${event.eventId}` === events[item.id]);
    if (!selected) { setNotice('Select a verified refund webhook event for this order.'); return; }
    void runAction(item.id, () => api(`/api/admin/order-resolution-cases/${encodeURIComponent(item.id)}/settle-refund`, { method: 'POST', body: JSON.stringify({ provider: selected.provider, providerEventId: selected.eventId }) }), 'Verified provider refund recorded.');
  };

  const visible = cases.filter(item => filter === 'OPEN' ? openStatuses.includes(item.status) : filter === 'REFUND_APPROVED' ? item.status === 'REFUND_APPROVED' : filter === 'CLOSED' ? ['RESOLVED', 'REJECTED'].includes(item.status) : true);
  const filters = [{ id: 'OPEN', name: 'Needs review' }, { id: 'REFUND_APPROVED', name: 'Awaiting settlement' }, { id: 'CLOSED', name: 'Resolved' }, { id: 'ALL', name: 'All cases' }];

  return <section className="orderResolutionAdmin"><header><div><p className="eyebrow">Buyer protection</p><h2>Refunds &amp; disputes</h2><p className="muted">Review the buyer claim and seller response. Refund approval is not payment: record verified provider webhook evidence, or a COD repayment reference, before closing.</p></div><span className="orderCaseLive"><i aria-hidden="true" /> Refreshes every 10 seconds</span></header>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <div className="empty" role="alert">Could not load order cases: {error}<button type="button" onClick={() => { setLoading(true); void load(); }}>Retry</button></div>}
    {!error && <><nav className="orderCaseFilters" aria-label="Filter refund and dispute cases">{filters.map(item => <button type="button" key={item.id} className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.name}<span>{item.id === 'OPEN' ? cases.filter(row => openStatuses.includes(row.status)).length : item.id === 'REFUND_APPROVED' ? cases.filter(row => row.status === 'REFUND_APPROVED').length : item.id === 'CLOSED' ? cases.filter(row => ['RESOLVED', 'REJECTED'].includes(row.status)).length : cases.length}</span></button>)}</nav>
      {loading ? <div className="empty" role="status">Loading order cases…</div> : visible.length === 0 ? <div className="empty">No cases in this queue.</div> : <div className="orderCaseAdminList">{visible.map(item => {
        const current = draft(item); const active = openStatuses.includes(item.status);
        return <article className="orderCaseAdminCard" key={item.id}>
          <header><div><p className="eyebrow">{item.orderNumber} · {item.storeName ?? 'Store'}</p><h3>{item.type === 'REFUND_REQUEST' ? 'Refund request' : 'Delivery dispute'}</h3><small>{item.buyerName} · {new Date(item.createdAt).toLocaleString()}</small></div><span className="orderCaseStatus">{label(item.status)}</span></header>
          <p><strong>{label(item.reason)}</strong></p><p>{item.description}</p>
          <p className="muted">Payment: {item.paymentMethod ?? '—'} · {item.paymentStatus ?? '—'} · Store order {formatMinor(item.sellerOrderTotalMinor, item.currency)} · Parent order {formatMinor(item.parentTotalMinor, item.currency)}</p>
          {item.messages.length > 0 && <ol className="orderCaseMessages">{item.messages.map(entry => <li key={entry.id}><div><strong>{entry.authorName || label(entry.authorRole)}</strong><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></div><p>{entry.body}</p></li>)}</ol>}
          {active && <form className="orderCaseReply" onSubmit={event => { event.preventDefault(); void sendReply(item); }}><label>Administrative update<textarea required minLength={2} maxLength={3000} value={current.reply} onChange={event => setDrafts(value => ({ ...value, [item.id]: { ...current, reply: event.target.value } }))} placeholder="Add a message visible to the buyer and seller" /></label><button disabled={busyId === item.id || current.reply.trim().length < 2}>{busyId === item.id ? 'Sending…' : 'Send update'}</button></form>}
          {openStatuses.includes(item.status) && <div className="orderCaseDecision"><h4>Review decision</h4><label>Refund amount in minor units<input type="number" min="1" max={item.sellerOrderTotalMinor} step="1" value={current.amount} onChange={event => setDrafts(value => ({ ...value, [item.id]: { ...current, amount: event.target.value } }))} /><small>Maximum: {formatMinor(item.sellerOrderTotalMinor, item.currency)}. Use minor units (for example, 2400 = $24.00).</small></label><label>Decision reason / buyer-facing note<textarea minLength={8} maxLength={1500} value={current.note} onChange={event => setDrafts(value => ({ ...value, [item.id]: { ...current, note: event.target.value } }))} placeholder="Explain the decision and next steps" /></label><div className="orderCaseDecisionActions"><button className="primary" disabled={busyId === item.id || (item.paymentMethod === 'COD' && item.paymentStatus !== 'PAID')} onClick={() => decide(item, 'APPROVE_REFUND')}>Approve refund</button><button disabled={busyId === item.id} onClick={() => decide(item, 'REJECT')}>Reject case</button>{item.paymentMethod === 'COD' && item.paymentStatus === 'PENDING' && <button disabled={busyId === item.id} onClick={() => decide(item, 'RESOLVE_NO_REFUND')}>Close · no COD collected</button>}</div>{item.paymentMethod === 'COD' && item.paymentStatus !== 'PAID' && <small>COD can be repaid only after the seller has recorded cash collection; no COD cash is held by the marketplace.</small>}</div>}
          {item.status === 'REFUND_APPROVED' && <div className="orderCaseDecision"><h4>Record actual refund settlement</h4>
            {item.paymentMethod === 'COD' ? <><p className="muted">Enter the seller's off-platform repayment reference. This records evidence only; COD funds are not held or transferred by the marketplace.</p><label>COD repayment reference<input required maxLength={200} value={current.refundEvidence} onChange={event => setDrafts(value => ({ ...value, [item.id]: { ...current, refundEvidence: event.target.value } }))} /></label></> : <><p className="muted">Select a successfully verified refund webhook associated with this exact parent order. Refunds are processed in Stripe or PayPal; this action does not call the provider.</p><label>Verified provider refund event<select value={events[item.id] ?? ''} onChange={event => setEvents(value => ({ ...value, [item.id]: event.target.value }))}><option value="">Choose a verified refund event</option>{item.providerRefundEvents.filter(event => event.currency?.toUpperCase() === item.currency.toUpperCase() && (event.amountMinor ?? 0) >= (item.approvedAmountMinor ?? Number.MAX_SAFE_INTEGER)).map(event => <option key={`${event.provider}:${event.eventId}`} value={`${event.provider}:${event.eventId}`}>{event.provider} · {event.eventId} · {formatMinor(event.amountMinor ?? 0, event.currency ?? item.currency)} · {new Date(event.receivedAt).toLocaleString()}</option>)}</select></label>{item.providerRefundEvents.length === 0 && <p className="notice">No verified refund webhook has been recorded for this order yet.</p>}</>}
            <button className="primary" disabled={busyId === item.id || (item.paymentMethod === 'COD' ? current.refundEvidence.trim().length < 3 : !events[item.id])} onClick={() => settle(item)}>Record settlement and close case</button>
          </div>}
          {item.status === 'RESOLVED' && <p className="receiptConfirmedLine">Resolved{item.settledAt ? ` · ${new Date(item.settledAt).toLocaleString()}` : ''}{item.manualRefundReference ? ` · COD reference ${item.manualRefundReference}` : item.providerWebhookEventRowId ? ' · verified provider refund event recorded' : ' · closed without refund'}.</p>}
          {item.status === 'REJECTED' && <p className="orderCaseResolutionNote">Case rejected. {item.resolutionNote}</p>}
        </article>;
      })}</div>}</>}
  </section>;
}
