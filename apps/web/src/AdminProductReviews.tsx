import React, { useEffect, useState } from 'react';

type Review = { id: string; rating: number; title: string; body: string; status: string; verifiedPurchase: boolean; createdAt: string; moderationNote?: string | null; product: { id: string; name: string; slug: string }; user: { id: string; name: string; email: string }; sellerOrder: { parent: { orderNumber: string; payment: { status: string } | null } } };

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function AdminProductReviews() {
  const [status, setStatus] = useState('PENDING');
  const [items, setItems] = useState<Review[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState('');
  const load = async () => { const result = await request<{ items: Review[] }>(`/api/admin/product-reviews?status=${encodeURIComponent(status)}`); setItems(result.items); };
  useEffect(() => { void load().catch(error => setMessage((error as Error).message)); }, [status]);
  const moderate = async (review: Review, decision: 'APPROVE' | 'REJECT') => {
    const reason = (reasons[review.id] ?? '').trim() || (decision === 'APPROVE' ? 'Meets review policy.' : 'Does not meet review policy.');
    setBusyId(review.id); setMessage('');
    try { await request(`/api/admin/product-reviews/${encodeURIComponent(review.id)}`, { method: 'PATCH', body: JSON.stringify({ decision, reason }) }); setMessage(`Review ${decision.toLowerCase()}d.`); await load(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusyId(''); }
  };
  return <section className="adminReviewQueue">
    <p className="eyebrow">Trust & safety</p><h2>Product reviews</h2>
    <p className="muted">Only verified purchasers with confirmed receipt can submit reviews. Reviews are public after approval; reward coins are granted only on approval and reversed on removal or a verified purchase refund.</p>
    {message && <p className="notice" role="status">{message}</p>}
    <nav className="dashboardTabs" aria-label="Review status">{['PENDING', 'APPROVED', 'REJECTED', 'REMOVED'].map(value => <button type="button" key={value} className={status === value ? 'primary' : ''} aria-pressed={status === value} onClick={() => setStatus(value)}>{value[0] + value.slice(1).toLowerCase()}</button>)}</nav>
    {!items.length ? <div className="empty">No {status.toLowerCase()} reviews.</div> : <div className="adminReviewList">{items.map(review => <article className="card adminReviewCard" key={review.id}>
      <header className="sectionHeading"><div><span className="adminWalletBadge">{review.status}</span><h3>{review.product.name}</h3><p className="muted">Order {review.sellerOrder.parent.orderNumber} · {review.sellerOrder.parent.payment?.status ?? 'Payment unavailable'} · {review.verifiedPurchase ? 'Verified purchase' : 'Purchase verification withdrawn'}</p></div><strong aria-label={`${review.rating} out of 5 stars`}>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</strong></header>
      <h4>{review.title}</h4><p>{review.body}</p><p className="muted">By {review.user.name} ({review.user.email}) · {new Date(review.createdAt).toLocaleString()}</p>
      {review.moderationNote && <p className="muted">Decision note: {review.moderationNote}</p>}
      {status === 'PENDING' && <><label>Moderation note<textarea maxLength={1000} value={reasons[review.id] ?? ''} onChange={event => setReasons(current => ({ ...current, [review.id]: event.target.value }))} placeholder="Optional for approval; required in policy for rejection" /></label><div className="profileActions"><button className="primary" disabled={busyId === review.id} onClick={() => void moderate(review, 'APPROVE')}>Approve review</button><button disabled={busyId === review.id} onClick={() => void moderate(review, 'REJECT')}>Reject review</button></div></>}
    </article>)}</div>}
  </section>;
}
