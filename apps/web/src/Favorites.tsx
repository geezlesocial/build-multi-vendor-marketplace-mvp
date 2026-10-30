import { useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import { ProductCardActions } from './ProductCardActions.js';
import { useSession } from './session.js';
import './Favorites.css';

type FavoriteProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  images: { url: string; alt: string }[];
  inventory: { quantity: number } | null;
  category: { name: string } | null;
  seller: { store: { name: string; slug: string } | null } | null;
};
type FavoriteRecord = { id: string; createdAt: string; productId: string; product: FavoriteProduct };

export function Favorites() {
  const { user } = useSession();
  const [items, setItems] = useState<FavoriteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!user) { setItems([]); setLoading(false); return undefined; }
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/favorites', { credentials: 'include' });
        const body = await response.json().catch(() => ({})) as FavoriteRecord[] | { error?: string };
        if (!response.ok) throw new Error(!Array.isArray(body) ? body.error ?? 'Could not load your favorites.' : 'Could not load your favorites.');
        if (active) setItems(Array.isArray(body) ? body : []);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load your favorites.');
      } finally { if (active) setLoading(false); }
    };
    void load();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; productId: string; favorited: boolean }>).detail;
      if (detail?.userId !== user.id) return;
      if (!detail.favorited) setItems(current => current.filter(item => item.productId !== detail.productId));
      else void load();
    };
    window.addEventListener('marketplace:favorite-changed', changed);
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('marketplace:favorite-changed', changed);
      window.removeEventListener('focus', load);
    };
  }, [user?.id, retry]);

  if (!user) return <section className="favoritesPage">
    <p className="eyebrow">Your saved finds</p><h1>Favorites</h1>
    <div className="favoritesEmpty"><h2>Sign in to see your favorites</h2><p>Products you like are saved to your account so you can find them again.</p><a className="primary" href="/?auth=login">Sign in</a></div>
  </section>;

  return <section className="favoritesPage" aria-labelledby="favorites-title">
    <p className="eyebrow">Your saved finds</p><h1 id="favorites-title">Favorites</h1>
    <p className="muted">Products you have liked are saved here. Unlike an item at any time to remove it.</p>
    {loading && <p role="status" aria-busy="true">Loading your favorites…</p>}
    {error && <div className="notice" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {!loading && !error && items.length === 0 && <div className="favoritesEmpty"><h2>No favorites yet</h2><p>Like a product while browsing and it will appear here.</p><a className="heroActionSecondary" href="/">Explore the marketplace</a></div>}
    {items.length > 0 && <div className="favoritesGrid">{items.map(({ product }) => {
      const store = product.seller?.store;
      const image = product.images[0];
      const quantity = product.inventory?.quantity ?? 0;
      const price = product.salePriceMinor != null && product.salePriceMinor < product.priceMinor ? product.salePriceMinor : product.priceMinor;
      return <article className="favoriteProduct card productCard" key={product.id}>
        {image ? <a href={`/products/${encodeURIComponent(product.id)}`}><img src={image.url} alt={image.alt || product.name} loading="lazy" /></a> : <a className="favoriteProductFallback" href={`/products/${encodeURIComponent(product.id)}`} aria-label={`View ${product.name}`}><span>{product.category?.name ?? 'Marketplace find'}</span></a>}
        <div className="cardBody">
          <p className="eyebrow">{store ? <a href={`/store/${encodeURIComponent(store.slug)}`}>{store.name}</a> : 'Official platform store'}</p>
          <h2><a href={`/products/${encodeURIComponent(product.id)}`}>{product.name}</a></h2>
          <p>{product.description}</p>
          <div className="cardBottom"><strong>{formatMinor(price, product.currency)}</strong><a className="heroActionSecondary" href={`/products/${encodeURIComponent(product.id)}`}>View product</a></div>
          <small>{quantity} available · {product.currency}</small>
          <ProductCardActions productId={product.id} productName={product.name} availableStock={quantity} hasSeller={Boolean(store)} />
        </div>
      </article>;
    })}</div>}
  </section>;
}
