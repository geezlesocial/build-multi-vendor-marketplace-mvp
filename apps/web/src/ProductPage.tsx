import React, { useEffect, useMemo, useState } from 'react';
import { formatMinor } from './money.js';
import { useSession } from './session.js';
import './ProductReviews.css';
import { JimaRecommendations } from './JimaRecommendations.js';
import { ProductCardActions } from './ProductCardActions.js';
import { ProductMediaGallery, type PublicProductVariant } from './ProductMediaGallery.js';
import { ProductVariantSelect } from './ProductVariantSelect.js';
import { applySeoMeta } from './seo-meta.js';

type Product = { id: string; name: string; slug: string; description: string; seoTitle?: string | null; seoDescription?: string | null; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; wholesaleEnabled?: boolean; wholesaleMinQuantity?: number | null; wholesaleMaxQuantity?: number | null; color?: string | null; category?: { name: string } | null; brand?: { name: string; slug: string } | null; features?: { id: string; name: string }[]; images?: { url: string; alt: string }[]; mediaAttachments?: { id: string; kind: string; url: string; label?: string | null; originalName?: string; detectedMime?: string }[]; variants?: PublicProductVariant[]; seller?: { store?: { name: string; slug: string } } };
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
  const [variantId, setVariantId] = useState("");
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
      setVariantId('');
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

  const gallery = useMemo(() => [...(product?.images ?? []).map(image => ({ id: image.url, kind: 'IMAGE', url: image.url, alt: image.alt })), ...(product?.mediaAttachments ?? [])], [product?.images, product?.mediaAttachments]);

  const add = async () => {
    if (!user) { window.location.assign('/?auth=login'); return; }
    if (product?.variants?.length && !variantId) throw new Error("Choose a color or option before adding this product to your cart.");
    await request('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId: id, quantity, ...(variantId ? { variantId } : {}) }) });
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
  const variants = product.variants ?? [];
  const selectedVariant = variants.find((variant) => variant.id === variantId) ?? null;
  const stock = variants.length ? selectedVariant?.stock ?? 0 : product.availableStock;
  const price = selectedVariant?.priceMinor ?? product.priceMinor;
  const currency = selectedVariant?.currency ?? product.currency;
  const salePrice = !selectedVariant && product.salePriceMinor != null && product.salePriceMinor < product.priceMinor ? product.salePriceMinor : null;
  return <section className="page productDetail">
    <a href="/" className="muted">← Back to marketplace</a>
    <div className="productDetailGrid"><ProductMediaGallery productName={product.name} media={gallery} variantImage={selectedVariant?.image} />
      <div><p className="eyebrow">Product · {product.seller?.store ? <a href={`/store/${product.seller.store.slug}`}>{product.seller.store.name}</a> : 'Platform store'}</p><h1>{product.name}</h1><p>{product.description}</p>{(product.category || product.brand || product.color || product.features?.length) && <dl className="productAttributes">{product.category && <div><dt>Category</dt><dd>{product.category.name}</dd></div>}{product.brand && <div><dt>Brand</dt><dd>{product.brand.name}</dd></div>}{product.color && <div><dt>Color</dt><dd>{product.color}</dd></div>}{Boolean(product.features?.length) && <div><dt>Features</dt><dd>{product.features!.map(feature => feature.name).join(' · ')}</dd></div>}</dl>}{product.wholesaleEnabled && <p className="wholesaleLabel">Wholesale item · minimum {product.wholesaleMinQuantity} · maximum {product.wholesaleMaxQuantity} units per order</p>}<ProductVariantSelect productName={product.name} variants={variants} value={variantId} onChange={(nextId) => { setVariantId(nextId); setQuantity(product.wholesaleEnabled ? product.wholesaleMinQuantity ?? 1 : 1); }} /><div className="productPriceLine">{salePrice != null && <del>{money(product.priceMinor, product.currency)}</del>}<strong className="productPrice">{money(salePrice ?? price, currency)}</strong>{salePrice != null && <span className="saleBadge">Sale</span>}</div><p className="muted">{stock} available{selectedVariant ? ` · ${selectedVariant.name}` : variants.length ? " · Choose a color or option to see stock" : ""} · Checkout uses the platform base currency.</p>{product.wholesaleEnabled && <label>Order quantity<input type="number" min={product.wholesaleMinQuantity ?? 1} max={Math.min(product.wholesaleMaxQuantity ?? 99, stock || 99)} step="1" value={quantity} onChange={event => setQuantity(Number(event.target.value))} /></label>}<button className="primary" disabled={!stock || (variants.length > 0 && !selectedVariant) || (product.wholesaleEnabled === true && stock < (product.wholesaleMinQuantity ?? 1)) || quantity < 1 || quantity > stock} onClick={() => void add().catch(error => setMessage(error.message))}>{variants.length > 0 && !selectedVariant ? 'Choose an option' : stock ? 'Add to cart' : 'Out of stock'}</button><ProductCardActions productId={product.id} productName={product.name} availableStock={stock} variantId={selectedVariant?.id} requiresVariantSelection={variants.length > 0} hasSeller={Boolean(product.seller?.store)} wholesaleMinQuantity={product.wholesaleEnabled ? product.wholesaleMinQuantity : null} />{message && <p className="notice" role="status">{message}</p>}</div></div>

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
