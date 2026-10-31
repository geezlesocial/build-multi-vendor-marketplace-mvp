import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatMinor } from './money.js';
import { LiveWatchModal, type LiveSession } from './LiveShopping.js';
import { JimaRecommendations } from './JimaRecommendations.js';
import { ProductCardActions } from './ProductCardActions.js';
import { MarketplaceAdPlacementSection } from './MarketplaceAds.js';
import { PublicCampaignPlacement, PublicCampaigns, type PublicCampaign } from './PublicCampaigns.js';

type User = { id: string; name: string; role: string; emailVerifiedAt?: string | null } | null;
type Product = { id: string; name: string; description: string; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; wholesaleEnabled?: boolean; wholesaleMinQuantity?: number | null; wholesaleMaxQuantity?: number | null; image: { url: string; alt: string } | null; category: { name: string; slug: string } | null; store: { name: string; slug: string } | null };
type Store = { id: string; name: string; slug: string; description: string | null; logoMediaId: string | null };
type HomeData = { hero: { title: string; description: string }; categories: { id: string; name: string; slug: string; imageUrl: string | null }[]; featuredDeals: Product[]; productCollection: Product[]; featuredStores: Store[] };
type SearchData = { products: (Product & { type: 'Product' })[]; stores: (Store & { type: 'Store' })[] };
type MemberData = { orders: { orderNumber: string; status: string }[]; cart: { items: { quantity: number }[] }; favorites: unknown[] };
type StoreRecommendation = { campaignId: string; impressionToken: string; product: { id: string; slug: string; name: string; description: string; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; category: string | null; image: { url: string; alt: string } | null }; store: { id: string; name: string; slug: string }; placement: 'ORGANIC'; reason: string };
type SponsoredProduct = { campaignId: string; impressionToken: string; billingModel: 'CPC' | 'CPV'; pricePerClickMinor: number; pricePer100ViewsMinor: number; headline: string; adDescription: string; creatives: { id: string; kind: 'IMAGE' | 'VIDEO'; url: string }[]; product: StoreRecommendation['product']; store: StoreRecommendation['store'] };

const money = (minor: number, currency: string) => formatMinor(minor, currency);

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'include', signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Marketplace request failed');
  return body as T;
}

function SponsoredProductCard({ item, onAdd }: { item: SponsoredProduct; onAdd: (productId: string) => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const clickSent = useRef(false);
  const [clickBusy, setClickBusy] = useState(false);
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return undefined;
    let sent = false;
    const sendImpression = () => {
      if (sent) return;
      sent = true;
      const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
      void fetch(`/api/store-buster/sponsored/${encodeURIComponent(item.campaignId)}/impression`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ impressionToken: item.impressionToken }) }).catch(() => undefined);
    };
    if (!('IntersectionObserver' in window)) { sendImpression(); return undefined; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5)) { sendImpression(); observer.disconnect(); } }, { threshold: 0.5 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [item.campaignId, item.impressionToken]);
  const recordClick = async () => {
    if (clickSent.current) return;
    clickSent.current = true;
    setClickBusy(true);
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    try { await Promise.race([fetch(`/api/store-buster/sponsored/${encodeURIComponent(item.campaignId)}/click`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ impressionToken: item.impressionToken, productId: item.product.id }), keepalive: true }), new Promise<void>(resolve => window.setTimeout(resolve, 1800))]); }
    catch { /* Navigation and cart actions remain available if ad measurement is temporarily offline. */ }
    finally { setClickBusy(false); }
  };
  const openProduct = async (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); await recordClick(); window.location.assign(`/products/${encodeURIComponent(item.product.id)}`); };
  const openStore = async (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); await recordClick(); window.location.assign(`/store/${encodeURIComponent(item.store.slug)}`); };
  const addToCart = async () => { await recordClick(); onAdd(item.product.id); };
  return <article className="card productCard sponsoredProductCard" ref={cardRef}>
    {item.creatives.length ? <div className="sponsoredCreativeGallery">{item.creatives.map(creative => creative.kind === 'VIDEO' ? <video key={creative.id} src={creative.url} controls playsInline preload="metadata" aria-label={item.headline + ' promotional video'} /> : <a key={creative.id} href={`/products/${item.product.id}`} onClick={event => void openProduct(event)}><img src={creative.url} alt={item.headline} loading="lazy" /></a>)}</div> : item.product.image ? <a href={`/products/${item.product.id}`} onClick={event => void openProduct(event)}><img src={item.product.image.url} alt={item.product.image.alt} /></a> : <a className="productVisual productVisualFallback" href={`/products/${item.product.id}`} onClick={event => void openProduct(event)} aria-label={`View ${item.product.name}`}><span className="productVisualLabel">{item.product.category ?? 'Featured'}</span></a>}
    <div className="cardBody"><p className="eyebrow">Sponsored · <a href={`/store/${encodeURIComponent(item.store.slug)}`} onClick={event => void openStore(event)}>{item.store.name}</a></p><h3><a href={`/products/${item.product.id}`} onClick={event => void openProduct(event)}>{item.headline || item.product.name}</a></h3><p>{item.adDescription || item.product.description}</p><p className="muted">Featured: {item.product.name}</p><div className="cardBottom"><strong>{money(item.product.salePriceMinor ?? item.product.priceMinor, item.product.currency)}</strong><button type="button" disabled={clickBusy} onClick={() => void addToCart()}>{clickBusy ? 'Opening…' : 'Add to cart'}</button></div><small>Paid placement · {item.billingModel === 'CPV' ? 'views are billed from the seller’s prepaid ad balance.' : 'qualified clicks are billed from the seller’s prepaid ad balance.'}</small><ProductCardActions productId={item.product.id} productName={item.product.name} availableStock={item.product.availableStock} hasSeller onSignIn={() => { window.location.assign('/?auth=login'); }} beforeBuy={recordClick} /></div>
  </article>;
}

export function MarketplaceHome({ user, onAdd, onSignIn }: { user: User; onAdd: (productId: string, quantity?: number) => void; onSignIn: () => void }) {
  const [home, setHome] = useState<HomeData | null>(null);
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('search') ?? '');
  const [search, setSearch] = useState<SearchData>({ products: [], stores: [] });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [memberData, setMemberData] = useState<MemberData | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberError, setMemberError] = useState('');
  const [recommendations, setRecommendations] = useState<StoreRecommendation[]>([]);
  const [recommendationMessage, setRecommendationMessage] = useState('');
  const [sponsoredProducts, setSponsoredProducts] = useState<SponsoredProduct[]>([]);
  const [campaigns, setCampaigns] = useState<PublicCampaign[]>([]);
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [watchLiveOpen, setWatchLiveOpen] = useState(false);
  const liveTrigger = useRef<HTMLButtonElement>(null);
  const closeLiveViewer = useCallback(() => {
    setWatchLiveOpen(false);
    window.requestAnimationFrame(() => liveTrigger.current?.focus());
  }, []);

  useEffect(() => {
    request<HomeData>('/api/marketplace/home').then(setHome).catch(error => setError(error.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (!liveSessions.length) setWatchLiveOpen(false); }, [liveSessions.length]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshCampaigns = () => {
      if (inFlight) return;
      inFlight = true;
      request<PublicCampaign[]>('/api/campaigns/active?placement=home').then(data => { if (active) setCampaigns(data); }).catch(() => undefined).finally(() => { inFlight = false; });
    };
    refreshCampaigns();
    const interval = window.setInterval(refreshCampaigns, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshLiveShows = () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      request<LiveSession[]>('/api/live-sessions').then(items => {
        if (active) setLiveSessions(items.filter(item => item.status === 'LIVE' && item.realtimeAvailable));
      }).catch(() => { if (active) setLiveSessions([]); }).finally(() => { inFlight = false; });
    };
    refreshLiveShows();
    const interval = window.setInterval(refreshLiveShows, 10_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshLiveShows(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  useEffect(() => {
    if (!user || user.role === 'ADMIN') { setMemberData(null); setRecommendations([]); setRecommendationMessage(''); return; }
    let active = true;
    let requestSequence = 0;
    const refreshMemberData = () => {
      const sequence = ++requestSequence;
      setMemberLoading(true);
      request<MemberData>('/api/dashboard/buyer').then(data => {
        if (active && sequence === requestSequence) { setMemberData(data); setMemberError(''); }
      }).catch(error => {
        if (active && sequence === requestSequence) setMemberError(error.message || 'Your account summary could not be refreshed.');
      }).finally(() => { if (active && sequence === requestSequence) setMemberLoading(false); });
    };
    refreshMemberData();
    window.addEventListener('marketplace:cart-changed', refreshMemberData);
    return () => { active = false; requestSequence += 1; window.removeEventListener('marketplace:cart-changed', refreshMemberData); };
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!user || user.role === 'ADMIN') return;
    request<{ items: StoreRecommendation[]; message?: string }>('/api/store-buster/recommendations').then(result => { setRecommendations(result.items); setRecommendationMessage(result.message ?? ''); }).catch(() => { setRecommendations([]); setRecommendationMessage('Personalized recommendations are temporarily unavailable.'); });
  }, [user?.id, user?.name, user?.role]);

  useEffect(() => {
    if (!user || user.role === 'ADMIN') { setSponsoredProducts([]); return; }
    let active = true;
    const refresh = () => { if (document.visibilityState !== 'visible') return; request<{ items: SponsoredProduct[] }>('/api/store-buster/sponsored').then(result => { if (active) setSponsoredProducts(result.items); }).catch(() => { if (active) setSponsoredProducts([]); }); };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); };
  }, [user?.id, user?.role]);

  const trackRecommendationClick = (campaignId: string, impressionToken: string) => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    void fetch(`/api/store-buster/campaigns/${encodeURIComponent(campaignId)}/click`, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ impressionToken }) }).catch(() => undefined);
  };
  const recordCategoryInterest = (categoryId: string) => {
    if (!user || user.role === 'ADMIN') return;
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    void fetch('/api/store-buster/signals', { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ type: 'SEARCH_CATEGORY', categoryId }) }).catch(() => undefined);
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
      <aside className="marketHeroVisual" aria-label="Featured marketplace preview"><div className="marketHeroVisualFrame">{cards[0]?.image ? <a href={`/products/${cards[0].id}`}><img src={cards[0].image.url} alt={cards[0].image.alt} /></a> : <div className="marketVisualFallback" aria-hidden="true"><span className="visualOrb visualOrbOne" /><span className="visualOrb visualOrbTwo" /><span className="visualShelf" /></div>}<div className="marketHeroVisualCaption"><span>Featured from the catalog</span><strong>{cards[0] ? <a href={`/products/${cards[0].id}`}>{cards[0].name}</a> : 'Thoughtful finds, ready to explore'}</strong><small>{cards[0]?.store?.name ?? 'Approved independent stores'}</small></div></div></aside>
    </div>
    {liveSessions.length > 0 && <section className="homeLiveSection" aria-labelledby="home-live-title"><div className="homeLiveHeading"><div><p className="eyebrow"><span className="homeLiveDot" /> Live from independent stores</p><h2 id="home-live-title">Watch live sellers</h2><p>Join a live show, discover featured products, and react in real time.</p></div><button ref={liveTrigger} className="primary" type="button" onClick={() => setWatchLiveOpen(true)}>Watch {liveSessions.length === 1 ? 'the live show' : 'live shows'} <span aria-hidden="true">↗</span></button></div><div className="homeLiveSellerRail">{liveSessions.slice(0, 4).map(session => <button type="button" className="homeLiveSeller" key={session.id} onClick={event => { liveTrigger.current = event.currentTarget; setWatchLiveOpen(true); }}><span className="homeLiveAvatar" aria-hidden="true">{(session.seller?.store?.name ?? 'S').slice(0, 1).toUpperCase()}</span><span><strong>{session.seller?.store?.name ?? 'Independent store'}</strong><small>{session.title}</small></span><span className="homeLiveNow">LIVE</span></button>)}{liveSessions.length > 4 && <button type="button" className="homeLiveMore" onClick={event => { liveTrigger.current = event.currentTarget; setWatchLiveOpen(true); }}>+{liveSessions.length - 4} more live</button>}</div></section>}
    <JimaRecommendations placement="home" />
    <MarketplaceAdPlacementSection placement="MARKETPLACE_HOME" title="Marketplace promotions" description="Promoted products from marketplace members. Sponsored placement does not change product review or checkout rules." />
    {user && user.role !== 'ADMIN' && <section className="memberHomePanel" aria-label="Your account overview"><div className="sectionHeading"><div><p className="eyebrow">A good place to pick up</p><h2>Your account at a glance</h2></div><a href="/settings#profile">Profile and settings</a></div>{memberData ? <><div className="memberHomeStats"><a className="memberStat" href="/dashboard?tab=orders"><span>Recent orders</span><strong>{memberData.orders.length}</strong><small>{memberData.orders[0]?.orderNumber ?? 'Your order history is ready'}</small></a><a className="memberStat" href="/checkout" aria-label={`In your cart: ${memberData.cart.items.reduce((sum, item) => sum + item.quantity, 0)} items`}><span>In your cart</span><strong aria-live="polite">{memberData.cart.items.reduce((sum, item) => sum + item.quantity, 0)}</strong><small>Continue to checkout when you’re ready</small></a><a className="memberStat" href="/dashboard?tab=favorites"><span>Saved favorites</span><strong>{memberData.favorites.length}</strong><small>Keep track of things you like</small></a></div>{memberError && <p className="muted" role="status">Your saved summary is shown; the latest refresh failed: {memberError} <button type="button" onClick={() => window.dispatchEvent(new Event('marketplace:cart-changed'))}>Retry summary</button></p>}</> : memberLoading ? <p className="muted" role="status" aria-busy="true">Loading your account summary…</p> : <div className="empty"><p>Your account summary is not available right now.</p><button type="button" onClick={() => window.dispatchEvent(new Event('marketplace:cart-changed'))}>Retry</button></div>}</section>}
    {user && user.role !== 'ADMIN' && (recommendations.length > 0 || recommendationMessage) && <section className="memberRecommendations" aria-labelledby="recommendations-title"><div className="sectionHeading"><div><p className="eyebrow">Optional personalization</p><h2 id="recommendations-title">Stores and products for you</h2></div><a href="/settings#personalization">Manage personalization</a></div>{recommendationMessage && <p className="muted" role="status">{recommendationMessage}</p>}{recommendations.length > 0 && <div className="grid">{recommendations.map(item => <article className="card productCard" key={`${item.campaignId}-${item.product.id}`}>{item.product.image ? <img src={item.product.image.url} alt={item.product.image.alt} /> : <div className="productVisual productVisualFallback" aria-hidden="true"><span className="productVisualLabel">{item.product.category ?? 'Recommended'}</span></div>}<div className="cardBody"><p className="eyebrow">Organic recommendation · {item.store.name}</p><h3><a href={`/products/${item.product.id}`} onClick={() => trackRecommendationClick(item.campaignId, item.impressionToken)}>{item.product.name}</a></h3><p>{item.reason}</p><div className="cardBottom"><strong>{money(item.product.priceMinor, item.product.currency)}</strong><a className="heroActionSecondary" href={`/store/${item.store.slug}`} onClick={() => trackRecommendationClick(item.campaignId, item.impressionToken)}>Visit store</a></div><small>{item.product.availableStock} available</small><ProductCardActions productId={item.product.id} productName={item.product.name} availableStock={item.product.availableStock} hasSeller onSignIn={() => { window.location.assign('/?auth=login'); }} beforeBuy={() => trackRecommendationClick(item.campaignId, item.impressionToken)} /></div></article>)}</div>}</section>}
    <PublicCampaigns campaigns={campaigns} />
    <div className="marketSearchWrap">
      <label className="search marketSearch"><span>Search products and stores</span><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Try “canvas”, “home”, or a store name" aria-controls="market-search-results" aria-expanded={results.length > 0} aria-autocomplete="list" /></label>
      {searching && <span className="muted searchStatus">Searching catalog…</span>}
      {results.length > 0 && <div id="market-search-results" className="searchResults" role="listbox" aria-label="Marketplace search results">{results.map((result, index) => <button key={`${result.type}-${result.id}`} className={index === activeIndex ? 'searchResult active' : 'searchResult'} role="option" aria-selected={index === activeIndex} onMouseDown={event => event.preventDefault()} onClick={() => selectResult(result)}><span className="resultType">{result.type}</span><span className="resultText"><strong>{result.name}</strong><small>{result.type === 'Product' ? `${result.store?.name ?? 'Platform store'} · ${money(result.priceMinor, result.currency)}` : result.description || 'Approved independent store'}</small></span></button>)}</div>}
      {query.trim().length >= 2 && !searching && !results.length && <p className="empty searchEmpty">No public products or stores matched that search.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
    </div>
    <section id="categories"><div className="sectionHeading"><div><p className="eyebrow">Browse by interest</p><h2>Start with a category</h2></div><span className="muted">Public, approved catalog</span></div><div className="categoryGrid">{home.categories.map(category => <a key={category.id} className="categoryChip" href={`/category/${encodeURIComponent(category.slug)}`} onClick={() => recordCategoryInterest(category.id)}>{category.name}</a>)}</div></section>
    {user && user.role !== 'ADMIN' && sponsoredProducts.length > 0 && <section className="memberRecommendations sponsoredPlacements" aria-labelledby="sponsored-title"><div className="sectionHeading"><div><p className="eyebrow">Paid placement · clearly labeled</p><h2 id="sponsored-title">Sponsored finds</h2><p className="muted">Independent stores may pay per verified click or per qualified view. These placements are separate from organic recommendations.</p></div></div><div className="grid">{sponsoredProducts.map(item => <SponsoredProductCard key={`${item.campaignId}-${item.product.id}`} item={item} onAdd={onAdd} />)}</div></section>}
    <section id="featured"><div className="sectionHeading"><div><p className="eyebrow">Featured collection</p><h2>Good finds from active stores</h2></div><span className="muted">{user ? 'Add to your cart when signed in' : 'Sign in to add items'}</span></div><PublicCampaignPlacement placement="collection" title="Featured collection promotions" /><MarketplaceAdPlacementSection placement="COLLECTIONS" title="Sponsored in this collection" /><div className="grid">{cards.map(product => <article className="card productCard" key={product.id}>{product.image ? <a href={`/products/${product.id}`}><img src={product.image.url} alt={product.image.alt} /></a> : <a className="productVisual productVisualFallback" href={`/products/${product.id}`} aria-label={`View ${product.name}`}><span className="visualOrb visualOrbOne" /><span className="visualOrb visualOrbTwo" /><span className="visualShelf" /><span className="productVisualLabel">{product.category?.name ?? 'Featured'}</span></a>}<div className="cardBody"><p className="eyebrow">Product · {product.store?.name ?? 'Platform store'}</p><h3><a href={`/products/${product.id}`}>{product.name}</a></h3><p>{product.description}</p>{product.wholesaleEnabled && <small className="wholesaleLabel">Wholesale · order {product.wholesaleMinQuantity}–{product.wholesaleMaxQuantity} units</small>}<div className="cardBottom"><strong>{money(product.salePriceMinor ?? product.priceMinor, product.currency)}</strong><button onClick={() => user ? onAdd(product.id, product.wholesaleEnabled ? product.wholesaleMinQuantity ?? 1 : 1) : onSignIn()} disabled={product.availableStock < (product.wholesaleEnabled ? product.wholesaleMinQuantity ?? 1 : 1)}>{product.availableStock > 0 ? 'Add to cart' : 'Out of stock'}</button></div>{product.salePriceMinor != null && <small><del>{money(product.priceMinor, product.currency)}</del> · Sale price</small>}<small>{product.availableStock} available</small><ProductCardActions productId={product.id} productName={product.name} availableStock={product.availableStock} hasSeller={Boolean(product.store)} wholesaleMinQuantity={product.wholesaleEnabled ? product.wholesaleMinQuantity : null} onSignIn={onSignIn} /></div></article>)}</div>{!cards.length && <div className="empty">No approved products are currently available.</div>}</section>
    <section id="stores"><div className="sectionHeading"><div><p className="eyebrow">Meet the stores</p><h2>Independent sellers, clearly labeled</h2></div></div><div className="storeGrid">{home.featuredStores.map(store => <a className="storeCard" key={store.id} href={`/store/${store.slug}`}><span className="storeLogo" aria-hidden="true"><span className="storeLogoMark" /></span><span><strong>{store.name}</strong><small>{store.description || 'View approved products'}</small></span><span aria-hidden="true">→</span></a>)}</div>{!home.featuredStores.length && <div className="empty">Approved stores will appear here.</div>}</section>
    {watchLiveOpen && <LiveWatchModal sessions={liveSessions} onClose={closeLiveViewer} canEarn={Boolean(user?.emailVerifiedAt)} canReact={Boolean(user)} />}
  </section>;
}
