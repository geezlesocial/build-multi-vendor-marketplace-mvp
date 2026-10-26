import { useState, type FormEvent } from 'react';
import { formatMinor } from './money.js';
import './OrderResolution.css';

type ResolutionCase = {
  id: string; type: string; status: string; reason: string; description: string; resolutionNote: string | null;
  approvedAmountMinor: number | null; settledAt: string | null;
  messages: { id: string; authorId: string; authorName: string | null; authorRole: string; body: string; createdAt: string }[];
};
type SellerOrder = { id: string; status: string; receivedAt: string | null; resolutionCase?: ResolutionCase | null };
type Props = { mode: 'buyer' | 'seller'; parentOrderId: string; sellerOrder: SellerOrder; currency: string; reload: () => void };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.headers ?? {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'Request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}

const statusLabel = (status: string) => status.replaceAll('_', ' ').toLowerCase().replace(/^./, value => value.toUpperCase());

export function OrderResolutionPanel({ mode, parentOrderId, sellerOrder, currency, reload }: Props) {
  const [type, setType] = useState('DELIVERY_DISPUTE');
  const [reason, setReason] = useState('ITEM_NOT_RECEIVED');
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const caseData = sellerOrder.resolutionCase;

  const createCase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage('');
    try {
      await request(`/api/orders/${encodeURIComponent(parentOrderId)}/shipments/${encodeURIComponent(sellerOrder.id)}/resolution-cases`, { method: 'POST', body: JSON.stringify({ type, reason, description }) });
      setDescription(''); setMessage('Your case was sent to the Store.');
      window.dispatchEvent(new Event('marketplace:orders-changed')); await reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!caseData || busy || !reply.trim()) return;
    setBusy(true); setMessage('');
    try {
      await request(`/api/order-resolution-cases/${encodeURIComponent(caseData.id)}/messages`, { method: 'POST', body: JSON.stringify({ body: reply }) });
      setReply(''); setMessage('Update sent.');
      window.dispatchEvent(new Event('marketplace:orders-changed')); await reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  if (!caseData) {
    if (mode !== 'buyer' || sellerOrder.receivedAt || sellerOrder.status === 'CANCELLED') return null;
    return <details className="orderResolutionPanel orderCaseStart"><summary>Need help with this item?</summary>
      <p className="muted">Open one refund request or delivery dispute for this Store order. An administrator reviews unresolved cases. Confirming receipt locks this in-app request path; statutory and payment-provider rights still apply.</p>
      <form onSubmit={event => void createCase(event)}>
        <div className="orderCaseFormGrid"><label>Request type<select value={type} onChange={event => setType(event.target.value)}><option value="DELIVERY_DISPUTE">Delivery dispute</option><option value="REFUND_REQUEST">Refund request</option></select></label>
          <label>Reason<select value={reason} onChange={event => setReason(event.target.value)}><option value="ITEM_NOT_RECEIVED">Item not received</option><option value="DAMAGED">Damaged item</option><option value="WRONG_ITEM">Wrong item</option><option value="MISSING_ITEMS">Missing items</option><option value="NOT_AS_DESCRIBED">Not as described</option><option value="OTHER">Other</option></select></label></div>
        <label>Describe the issue<textarea required minLength={10} maxLength={3000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Tell the Store what happened and what outcome would help." /></label>
        <button className="primary" disabled={busy || description.trim().length < 10}>{busy ? 'Sending…' : 'Open order case'}</button>
      </form>{message && <p role={message.includes('sent') ? 'status' : 'alert'} className={message.includes('sent') ? 'receiptConfirmedLine' : 'notice'}>{message}</p>}
    </details>;
  }

  const terminal = ['RESOLVED', 'REJECTED'].includes(caseData.status) || caseData.status === 'REFUND_APPROVED';
  return <section className="orderResolutionPanel" aria-label="Order case">
    <header><div><strong>{caseData.type === 'REFUND_REQUEST' ? 'Refund request' : 'Delivery dispute'}</strong><small>{caseData.reason.replaceAll('_', ' ')} · {statusLabel(caseData.status)}</small></div><span className="orderCaseStatus">{statusLabel(caseData.status)}</span></header>
    <p>{caseData.description}</p>
    {caseData.approvedAmountMinor != null && <p className="muted">Approved refund: {formatMinor(caseData.approvedAmountMinor, currency)}{caseData.status === 'REFUND_APPROVED' ? ' · awaiting verified settlement' : ''}</p>}
    {caseData.resolutionNote && <p className="orderCaseResolutionNote"><strong>Admin resolution:</strong> {caseData.resolutionNote}</p>}
    {caseData.messages.length > 0 && <ol className="orderCaseMessages">{caseData.messages.map(item => <li key={item.id}><div><strong>{item.authorName || statusLabel(item.authorRole)}</strong><time dateTime={item.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</time></div><p>{item.body}</p></li>)}</ol>}
    {!terminal && <form className="orderCaseReply" onSubmit={event => void sendReply(event)}><label>{mode === 'buyer' ? 'Add information' : 'Reply to the buyer'}<textarea required minLength={2} maxLength={3000} value={reply} onChange={event => setReply(event.target.value)} placeholder="Write an update for this case" /></label><button disabled={busy || reply.trim().length < 2}>{busy ? 'Sending…' : 'Send update'}</button></form>}
    {message && <p role={message.includes('sent') ? 'status' : 'alert'} className={message.includes('sent') ? 'receiptConfirmedLine' : 'notice'}>{message}</p>}
  </section>;
}
