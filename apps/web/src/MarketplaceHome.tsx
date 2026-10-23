import React, { useEffect, useRef, useState } from 'react';

type User = { id: string; name: string; role: string } | null;
type Product = { id: string; name: string; description: string; priceMinor: number; currency: string; availableStock: number; image: { url: string; alt: string } | null; category: { name: string; slug: string } | null; store: { name: string; slug: string } | null };
type Store = { id: string; name: string; slug: string; description: string | null; logoMediaId: string | null };
type HomeData = { hero: { title: string; description: string }; categories: { id: string; name: string; slug: string; imageUrl: string | null }[]; featuredDeals: Product[]; productCollection: Product[]; featuredStores: Store[] };
type SearchData = { products: (Product & { type: 'Product' })[]; stores: (Store & { type: 'Store' })[] };
type MemberData = { orders: { orderNumber: string; status: string }[]; cart: { items: { quantity: number }[] }; favorites: unknown[] };
type StoreRecommendation = { campaignId: string; impressionToken: string; product: { id: string; slug: string; name: string; description: string; priceMinor: number; currency: string; category: string | null; image: { url: string; alt: string } | null }; store: { id: string; name: string; slug: string }; placement: 'ORGANIC'; reason: string };

const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'include', signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Marketplace request failed');
  return body as T;
}

export function MarketplaceHome({ user, onAdd, onSignIn }: { user: User; onAdd: (productId: string) => void; onSignIn: () => void }) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchData>({ products: [], stores: [] });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [memberData, setMemberData] = useState<MemberData | null>(null);
  const [recommendations, setRecommendations] = useState<StoreRecommendation[]>([]);
  const [recommendationMessage, setRecommendationMessage] = useState('');

  useEffect(() => {
    request<HomeData>('/api/marketplace/home').then(setHome).catch(error => setError(error.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user || user.role === 'ADMIN') { setMemberData(null); setRecommendations([]); setRecommendationMessage(''); return; }
    request<MemberData>('/api/dashboard/buyer').then(setMemberData).catch(() => setMemberData(null));
    request<{ items: StoreRecommendation[]; message?: string }>('/api/store-buster/recommendations').then(result => { setRecommendations(result.items); setRecommendationMessage(result.message ?? ''); }).catch(() => { setRecommendations([]); setRecommendationMessage('Personalized recommendations are temporarily unavailable.'); });
  }, [user?.id, user?.name, user?.role]);

  const trackRecommendationClick = (campaignId: string, impressionToken: string) => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    void fetch(`/api/store-buster/campaigns/${encodeURIComponent(campaignId)}/click`, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ impressionToken }) }).catch(() => undefined);
  };
  const recordCategoryInterest = (categoryId: string) => {
    if (!user || user.role === 'ADMIN') return;
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    void fetch('/api/store-buster/signals', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ type: 'SEARCH_CATEGORY', categoryId }) }).catch(() => undefined);
  };

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) { setSearch({ products: [], stores: [] }); setSearching(false); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      request<SearchData>(`/api/marketplace/search?q=${encodeURIComponent(value)}&limit=6`, controller.signal)
        .then(result => { setSearch(result); setActiveIndex(-1); setError(''); })
        .catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); })
        .finally(() => setSearching(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const results = [...search.products, ...search.stores];
  const selectResult = (result: (Product & { type: 'Product' }) | (Store & { type: 'Store' })) => {
    window.location.assign(result.type === 'Product' ? `/products/${result.id}` : `/store/${result.slug}`);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => (index + 1) % results.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => (index - 1 + results.length) % results.length); }
    if (event.key === 'Escape') { setQuery(''); searchRef.current?.blur(); }
    if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); selectResult(results[activeIndex]); }
  };

  if (loading) return <section className="page"><p className="eyebrow">Market Lane</p><h1>Loading the marketplace…</h1></section>;
  if (!home) return <section className="page"><h1>Marketplace unavailable</h1><p className="notice">{error || 'Try again when the local API is available.'}</p></section>;

  const cards = [...home.featuredDeals, ...home.productCollection];
  return <section className="page marketplaceHome">
    <div className="marketHero">
      <div className="marketHeroCopy"><p className="eyebrow">{user ? user.role === 'ADMIN' ? 'Marketplace control room' : 'Your Market Lane' : 'Market Lane · independent marketplace'}</p><h1>{user && user.role !== 'ADMIN' ? `Good to see you, ${user.name.split(/\s+/)[0]}.` : user?.role === 'ADMIN' ? 'A clear view of the marketplace.' : home.hero.title}</h1><p>{user && user.role !== 'ADMIN' ? 'Pick up where you left off, check your account, or discover something new from independent stores.' : home.hero.description}</p><div className="marketHeroActions">{user && user.role !== 'ADMIN' ? <><a className="primary heroAction" href="/dashboard">Open your dashboard</a><a className="heroActionSecondary" href="/dashboard?tab=orders">View orders</a>{user.role === 'SELLER' && <a className="heroActionSecondary" href="/dashboard?mode=seller">Seller tools</a>}</> : user?.role === 'ADMIN' ? <><a className="primary heroAction" href="/admin/platform">Open admin dashboard</a><a className="heroActionSecondary" href="#featured">Browse public catalog</a></> : <><a className="primary heroAction" href="#featured">Browse the collection</a><a className="heroActionSecondary" href="#stores">Meet the stores</a><a className="heroActionSecondary" href="/?auth=login">Sign in</a><a className="heroActionSecondary" href="/?auth=register">Create account</a></>}</div><div className="heroPills"><span>Approved catalog only</span><span>Server-validated stock</span><span>Clear checkout totals</span></div></div>
      <aside className="marketHeroVisual" aria-label="Featured marketplace preview"><div className="marketHeroVisualFrame">{cards[0]?.image ? <img src={cards[0].image.url} alt={cards[0].image.alt} /> : <div className="marketVisualFallback" aria-hidden="true"><span className="visualOrb visualOrbOne" /><span className="visualOrb visualOrbTwo" /><span className="visualShelf" /></div>}<div className="marketHeroVisualCaption"><span>Featured from the catalog</span><strong>{cards[0]?.name ?? 'Thoughtful finds, ready to explore'}</strong><small>{cards[0]?.store?.name ?? 'Approved independent stores'}</small></div></div></aside>
    </div>
    {user && user.role !== 'ADMIN' && <section className="memberHomePanel" aria-label="Your account overview"><div className="sectionHeading"><div><p className="eyebrow">A good place to pick up</p><h2>Your account at a glance</h2></div><a href="/settings#profile">Profile and settings</a></div>{memberData ? <div className="memberHomeStats"><a className="memberStat" href="/dashboard?tab=orders"><span>Recent orders</span><strong>{memberData.orders.length}</strong><small>{memberData.orders[0]?.orderNumber ?? 'Your order history is ready'}</small></a><a className="memberStat" href="/checkout"><span>In your cart</span><strong>{memberData.cart.items.reduce((sum, item) => sum + item.quantity, 0)}</strong><small>Continue to checkout when you’re ready</small></a><a className="memberStat" href="/dashboard?tab=favorites"><span>Saved favorites</span><strong>{memberData.favorites.length}</strong><small>Keep track of things you like</small></a></div> : <p className="muted" role="status">Your account summary is not available right now.</p>}</section>}
    {user && user.role !== 'ADMIN' && (recommendations.length > 0 || recommendationMessage) && <section className="memberRecommendations" aria-labelledby="recommendations-title"><div className="sectionHeading"><div><p className="eyebrow">Optional personalization</p><h2 id="recommendations-title">Stores and products for you</h2></div><a href="/settings#personalization">Manage personalization</a></div>{recommendationMessage && <p className="muted" role="status">{recommendationMessage}</p>}{recommendations.length > 0 && <div className="grid">{recommendations.map(item => <article className="card productCard" key={`${item.campaignId}-${item.product.id}`}>{item.product.image ? <img src={item.product.image.url} alt={item.product.image.alt} /> : <div className="productVisual productVisualFallback" aria-hidden="true"><span className="productVisualLabel">{item.product.category ?? 'Recommended'}</span></div>}<div className="cardBody"><p className="eyebrow">Organic recommendation · {item.store.name}</p><h3><a href={`/products/${item.product.id}`} onClick={() => trackRecommendationClick(item.campaignId, item.impressionToken)}>{item.product.name}</a></h3><p>{item.reason}</p><div className="cardBottom"><strong>{money(item.product.priceMinor, item.product.currency)}</strong><a className="heroActionSecondary" href={`/store/${item.store.slug}`} onClick={() => trackRecommendationClick(item.campaignId, item.impressionToken)}>Visit store</a></div></div></article>)}</div>}</section>}
    <div className="marketSearchWrap">
      <label className="search marketSearch"><span>Search products and stores</span><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Try “canvas”, “home”, or a store name" aria-controls="market-search-results" aria-expanded={results.length > 0} aria-autocomplete="list" /></label>
      {searching && <span className="muted searchStatus">Searching catalog…</span>}
      {results.length > 0 && <div id="market-search-results" className="searchResults" role="listbox" aria-label="Marketplace search results">{results.map((result, index) => <button key={`${result.type}-${result.id}`} className={index === activeIndex ? 'searchResult active' : 'searchResult'} role="option" aria-selected={index === activeIndex} onMouseDown={event => event.preventDefault()} onClick={() => selectResult(result)}><span className="resultType">{result.type}</span><span className="resultText"><strong>{result.name}</strong><small>{result.type === 'Product' ? `${result.store?.name ?? 'Platform store'} · ${money(result.priceMinor, result.currency)}` : result.description || 'Approved independent store'}</small></span></button>)}</div>}
      {query.trim().length >= 2 && !searching && !results.length && <p className="empty searchEmpty">No public products or stores matched that search.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
    </div>
    <section id="categories"><div className="sectionHeading"><div><p className="eyebrow">Browse by interest</p><h2>Start with a category</h2></div><span className="muted">Public, approved catalog</span></div><div className="categoryGrid">{home.categories.map(category => <button key={category.id} className="categoryChip" onClick={() => { setQuery(category.name); recordCategoryInterest(category.id); }}>{category.name}</button>)}</div></section>
    <section id="featured"><div className="sectionHeading"><div><p className="eyebrow">Featured collection</p><h2>Good finds from active stores</h2></div><span className="muted">{user ? 'Add to your cart when signed in' : 'Sign in to add items'}</span></div><div className="grid">{cards.map(product => <article className="card productCard" key={product.id}>{product.image ? <img src={product.image.url} alt={product.image.alt} /> : <div className="productVisual productVisualFallback" aria-hidden="true"><span className="visualOrb visualOrbOne" /><span className="visualOrb visualOrbTwo" /><span className="visualShelf" /><span className="productVisualLabel">{product.category?.name ?? 'Featured'}</span></div>}<div className="cardBody"><p className="eyebrow">Product · {product.store?.name ?? 'Platform store'}</p><h3>{product.name}</h3><p>{product.description}</p><div className="cardBottom"><strong>{money(product.priceMinor, product.currency)}</strong><button onClick={() => user ? onAdd(product.id) : onSignIn()} disabled={product.availableStock < 1}>{product.availableStock > 0 ? 'Add to cart' : 'Out of stock'}</button></div><small>{product.availableStock} available</small></div></article>)}</div>{!cards.length && <div className="empty">No approved products are currently available.</div>}</section>
    <section id="stores"><div className="sectionHeading"><div><p className="eyebrow">Meet the stores</p><h2>Independent sellers, clearly labeled</h2></div></div><div className="storeGrid">{home.featuredStores.map(store => <a className="storeCard" key={store.id} href={`/store/${store.slug}`}><span className="storeLogo" aria-hidden="true"><span className="storeLogoMark" /></span><span><strong>{store.name}</strong><small>{store.description || 'View approved products'}</small></span><span aria-hidden="true">→</span></a>)}</div>{!home.featuredStores.length && <div className="empty">Approved stores will appear here.</div>}</section>
  </section>;
}
