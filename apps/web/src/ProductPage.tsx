import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import { useSession } from './session.js';
import './ProductReviews.css';
import { JimaRecommendations } from './JimaRecommendations.js';
import { ProductCardActions } from './ProductCardActions.js';
import { applySeoMeta } from './seo-meta.js';

type Product = { id: string; name: string; slug: string; description: string; seoTitle?: string | null; seoDescription?: string | null; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; wholesaleEnabled?: boolean; wholesaleMinQuantity?: number | null; wholesaleMaxQuantity?: number | null; color?: string | null; category?: { name: string } | null; brand?: { name: string; slug: string } | null; features?: { id: string; name: string }[]; images?: { url: string; alt: string }[]; mediaAttachments?: { id: string; kind: string; url: string; label?: string | null; originalName?: string; detectedMime?: string }[]; seller?: { store?: { name: string; slug: string } } };
type Review = { id: string; rating: number; title: string; body: string; reviewerName: string; verifiedPurchase: boolean; createdAt: string };
type ReviewData = { averageRating: number | null; reviewCount: number; canReview: boolean; reason: string; existingReview: { id: string; status: string } | null; items: Review[] };
const money = (minor: number, currency: string) => formatMinor(minor, currency);

async function request<T>(path: string, options: RequestInit = {}) {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
  const response = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function ProductPage({ id }: { id: string }) {
  const { user } = useSession();
  const [product, setProduct] = useState<Product | null>(null);
  const [reviews, setReviews] = useState<ReviewData | null>(null);
  const [message, setMessage] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [reviewError, setReviewError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [draft, setDraft] = useState({ rating: 5, title: '', body: '' });

  const loadReviews = async () => setReviews(await request<ReviewData>(`/api/products/${encodeURIComponent(id)}/reviews`));
  useEffect(() => {
    let active = true;
    fetch(`/api/products/${encodeURIComponent(id)}`).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Product unavailable');
      if (!active) return;
      setProduct(body);
      setQuantity(body.wholesaleEnabled ? body.wholesaleMinQuantity ?? 1 : 1);
      const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
      void fetch('/api/store-buster/signals', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ type: 'PRODUCT_VIEW', productId: body.id }) }).catch(() => undefined);
    }).catch(error => { if (active) setMessage(error.message); });
    void loadReviews().catch(error => { if (active) setReviewError(error.message); });
    return () => { active = false; };
  }, [id, user?.id]);

  useEffect(() => {
    if (!product) return undefined;
    return applySeoMeta(product.seoTitle || `${product.name} | Market Lane`, product.seoDescription || product.description, `${product.name} | Market Lane`);
  }, [product]);

  const add = async () => {
    if (!user) { window.location.assign('/?auth=login'); return; }
    await request('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId: id, quantity }) });
    setMessage('Added to cart.');
    window.dispatchEvent(new Event('marketplace:cart-changed'));
  };

  const submitReview = async (event: React.FormEvent) => {
    event.preventDefault(); setReviewBusy(true); setReviewError(''); setMessage('');
    try {
      const result = await request<{ message: string }>(`/api/products/${encodeURIComponent(id)}/reviews`, { method: 'POST', body: JSON.stringify(draft) });
      setMessage(result.message); setDraft({ rating: 5, title: '', body: '' }); await loadReviews();
    } catch (error) { setReviewError((error as Error).message); }
    finally { setReviewBusy(false); }
  };

  if (!product) return <section className="page"><h1>{message || 'Loading product…'}</h1>{message && <a className="primary" href="/">Back to marketplace</a>}</section>;
  const gallery = [...(product.images ?? []).map(image => ({ id: image.url, kind: 'IMAGE', url: image.url, label: image.alt, originalName: undefined as string | undefined, detectedMime: 'image/webp' })), ...(product.mediaAttachments ?? [])];
  const salePrice = product.salePriceMinor != null && product.salePriceMinor < product.priceMinor ? product.salePriceMinor : null;
  return <section className="page productDetail">
    <a href="/" className="muted">← Back to marketplace</a>
    <div className="productDetailGrid"><div className="productGallery">{gallery.map((media, index) => media.kind === 'IMAGE' ? <img key={media.id} src={media.url} alt={media.label || `${product.name} image ${index + 1}`} loading={index ? 'lazy' : 'eager'} /> : media.kind === 'VIDEO' ? <video key={media.id} controls preload="metadata" aria-label={media.label || `${product.name} video`}><source src={media.url} type={media.detectedMime} /></video> : media.kind === 'DOCUMENT' ? <a key={media.id} href={media.url} download>{media.label || media.originalName || 'Download product file'}</a> : null)}{gallery.length === 0 && <div className="productMark productHeroMark" aria-hidden="true">{product.name.slice(0, 1)}</div>}</div>
      <div><p className="eyebrow">Product · {product.seller?.store ? <a href={`/store/${product.seller.store.slug}`}>{product.seller.store.name}</a> : 'Platform store'}</p><h1>{product.name}</h1><p>{product.description}</p>{(product.category || product.brand || product.color || product.features?.length) && <dl className="productAttributes">{product.category && <div><dt>Category</dt><dd>{product.category.name}</dd></div>}{product.brand && <div><dt>Brand</dt><dd>{product.brand.name}</dd></div>}{product.color && <div><dt>Color</dt><dd>{product.color}</dd></div>}{Boolean(product.features?.length) && <div><dt>Features</dt><dd>{product.features!.map(feature => feature.name).join(' · ')}</dd></div>}</dl>}{product.wholesaleEnabled && <p className="wholesaleLabel">Wholesale item · minimum {product.wholesaleMinQuantity} · maximum {product.wholesaleMaxQuantity} units per order</p>}<div className="productPriceLine">{salePrice != null && <del>{money(product.priceMinor, product.currency)}</del>}<strong className="productPrice">{money(salePrice ?? product.priceMinor, product.currency)}</strong>{salePrice != null && <span className="saleBadge">Sale</span>}</div><p className="muted">{product.availableStock} available · Checkout uses the platform base currency.</p>{product.wholesaleEnabled && <label>Order quantity<input type="number" min={product.wholesaleMinQuantity ?? 1} max={Math.min(product.wholesaleMaxQuantity ?? 99, product.availableStock)} step="1" value={quantity} onChange={event => setQuantity(Number(event.target.value))} /></label>}<button className="primary" disabled={!product.availableStock || (product.wholesaleEnabled === true && product.availableStock < (product.wholesaleMinQuantity ?? 1)) || quantity < 1 || quantity > product.availableStock} onClick={() => void add().catch(error => setMessage(error.message))}>{product.availableStock ? 'Add to cart' : 'Out of stock'}</button><ProductCardActions productId={product.id} productName={product.name} availableStock={product.availableStock} hasSeller={Boolean(product.seller?.store)} wholesaleMinQuantity={product.wholesaleEnabled ? product.wholesaleMinQuantity : null} />{message && <p className="notice" role="status">{message}</p>}</div></div>

    <JimaRecommendations placement="product" />
    <section className="productReviews" aria-labelledby="product-reviews-title">
      <header className="sectionHeading"><div><p className="eyebrow">Verified buyer feedback</p><h2 id="product-reviews-title">Customer reviews</h2></div><strong>{reviews?.averageRating == null ? 'No rating yet' : `${reviews.averageRating.toFixed(1)} / 5`} · {reviews?.reviewCount ?? 0} reviews</strong></header>
      {reviewError && <p className="notice" role="alert">{reviewError}</p>}
      {user && reviews?.canReview && <form className="productReviewForm" onSubmit={event => void submitReview(event)}><h3>Share your experience</h3><p className="muted">Reviews are checked by the marketplace before publication.</p><label>Rating<select value={draft.rating} onChange={event => setDraft({ ...draft, rating: Number(event.target.value) })}>{[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} out of 5 stars</option>)}</select></label><label>Title<input required minLength={2} maxLength={120} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><label>Your review<textarea required minLength={10} maxLength={3000} rows={5} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label><button className="primary" disabled={reviewBusy}>{reviewBusy ? 'Submitting…' : 'Submit review'}</button></form>}
      {user && reviews && !reviews.canReview && <p className="muted">{reviews.reason}{!user.emailVerifiedAt && <> <a href="/settings#profile">Verify your email in settings</a>.</>}</p>}
      {!user && <p className="muted">Sign in with the account used for a paid, received purchase to leave a review. <a href="/?auth=login">Sign in</a></p>}
      {!reviews?.items.length && <div className="empty">No approved reviews yet.</div>}
      <div className="productReviewList">{reviews?.items.map(review => <article className="productReview" key={review.id}><header><span aria-label={`${review.rating} out of 5 stars`}>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString()}</time></header><h3>{review.title}</h3><p>{review.body}</p><small>{review.reviewerName} · {review.verifiedPurchase ? 'Verified purchase' : 'Purchase verification withdrawn'}</small></article>)}</div>
    </section>
  </section>;
}
