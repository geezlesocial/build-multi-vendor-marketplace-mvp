import React, { useEffect, useState } from 'react';
import { useSession } from './session.js';
import { formatMinor } from './money.js';
import { ProductCardActions } from './ProductCardActions.js';
import { MarketplaceAdPlacementSection } from './MarketplaceAds.js';
import { PublicCampaignPlacement } from './PublicCampaigns.js';
import './MarketplaceCategory.css';

type CategoryProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  availableStock: number;
  wholesaleEnabled?: boolean;
  wholesaleMinQuantity?: number | null;
  wholesaleMaxQuantity?: number | null;
  image: { url: string; alt: string } | null;
  category: { name: string; slug: string } | null;
  store: { name: string; slug: string } | null;
};
type CategoryPageData = {
  category: { id: string; name: string; slug: string; description: string | null; imageUrl: string | null };
  children: { id: string; name: string; slug: string; description: string | null; imageUrl: string | null }[];
  items: CategoryProduct[];
};

export function MarketplaceCategory({ slug }: { slug: string }) {
  const { user } = useSession();
  const [data, setData] = useState<CategoryPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`/api/marketplace/categories/${encodeURIComponent(slug)}`, { credentials: 'include', signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'This category could not be loaded.');
        return body as CategoryPageData;
      })
      .then(result => { setData(result); document.title = `${result.category.name} | Market Lane`; })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'This category could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [slug]);

  const addToCart = async (product: CategoryProduct) => {
    if (!user) { window.location.assign('/?auth=login'); return; }
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    setMessage('');
    try {
      const response = await fetch('/api/cart/items', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ productId: product.id, quantity: product.wholesaleEnabled ? product.wholesaleMinQuantity ?? 1 : 1 }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not add this item to your cart.');
      window.dispatchEvent(new Event('marketplace:cart-changed'));
      setMessage(`${product.name} was added to your cart.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add this item to your cart.'); }
  };

  if (loading) return <section className="page marketplaceCategoryPage" aria-busy="true"><p className="eyebrow">Marketplace category</p><h1>Loading category…</h1><p className="muted" role="status">Finding approved, available products.</p></section>;
  if (error || !data) return <section className="page marketplaceCategoryPage"><p className="eyebrow">Marketplace category</p><h1>Category unavailable</h1><p className="notice" role="alert">{error || 'This category is unavailable.'}</p><a className="heroActionSecondary" href="/">Return to marketplace</a></section>;

  return <section className="page marketplaceCategoryPage">
    <p className="eyebrow"><a href="/">Marketplace</a> · Category</p>
    <h1>{data.category.name}</h1>
    {data.category.description && <p className="categoryDescription">{data.category.description}</p>}
    {data.children.length > 0 && <nav className="categorySubcategories" aria-label={`Subcategories of ${data.category.name}`}>{data.children.map(child => <a className="categoryChip" key={child.id} href={`/category/${encodeURIComponent(child.slug)}`}>{child.name}</a>)}</nav>}
    <PublicCampaignPlacement placement="category" title={`Promotions in ${data.category.name}`} />
    <MarketplaceAdPlacementSection placement="CATEGORY_PAGES" title={`Sponsored in ${data.category.name}`} />
    {message && <p className="notice" role="status" aria-live="polite">{message}</p>}
    <div className="sectionHeading"><h2>Approved products</h2><span className="muted">{data.items.length} shown</span></div>
    {data.items.length ? <div className="grid">{data.items.map(product => {
      const minQuantity = product.wholesaleEnabled ? product.wholesaleMinQuantity ?? 1 : 1;
      const price = product.salePriceMinor ?? product.priceMinor;
      return <article className="card productCard" key={product.id}>
        {product.image ? <a href={`/products/${encodeURIComponent(product.id)}`}><img src={product.image.url} alt={product.image.alt || product.name} loading="lazy" /></a> : <a className="productVisual productVisualFallback" href={`/products/${encodeURIComponent(product.id)}`} aria-label={`View ${product.name}`}><span className="productVisualLabel">{product.category?.name ?? data.category.name}</span></a>}
        <div className="cardBody"><p className="eyebrow">{product.store?.name ?? 'Marketplace product'}</p><h3><a href={`/products/${encodeURIComponent(product.id)}`}>{product.name}</a></h3><p>{product.description}</p>
          {product.wholesaleEnabled && <small className="wholesaleLabel">Wholesale · order {product.wholesaleMinQuantity}–{product.wholesaleMaxQuantity} units</small>}
          <div className="cardBottom"><strong>{formatMinor(price, product.currency)}</strong><button type="button" disabled={product.availableStock < minQuantity} onClick={() => void addToCart(product)}>{product.availableStock >= minQuantity ? product.wholesaleEnabled ? `Add ${minQuantity} to cart` : 'Add to cart' : 'Out of stock'}</button></div>
          {product.salePriceMinor != null && <small><del>{formatMinor(product.priceMinor, product.currency)}</del> · Sale price</small>}
          <small>{product.availableStock} available</small>
          {product.store && <p><a href={`/store/${encodeURIComponent(product.store.slug)}`}>Visit {product.store.name}</a></p>}
          <ProductCardActions productId={product.id} productName={product.name} availableStock={product.availableStock} hasSeller={Boolean(product.store)} wholesaleMinQuantity={product.wholesaleEnabled ? product.wholesaleMinQuantity : null} onSignIn={() => { window.location.assign('/?auth=login'); }} />
        </div>
      </article>;
    })}</div> : <div className="empty"><h3>No available products yet</h3><p>Approved, in-stock products in this category will appear here.</p><a href="/">Browse the marketplace</a></div>}
  </section>;
}
