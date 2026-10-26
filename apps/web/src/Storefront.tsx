import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

type StorefrontData = {
  name: string;
  slug: string;
  publicPath: string;
  theme: { themePreset: string; mobileTemplate: string; description: string; primaryColor: string; accentColor: string; font: string; logoMediaId: string | null; faviconMediaId: string | null; bannerMediaId: string | null };
  products: { id: string; name: string; description: string; priceMinor: number; salePriceMinor?: number | null; currency: string; availableStock: number; category: { name: string } | null; images?: { url: string; alt: string }[]; mediaAttachments?: { kind: string; url: string; label?: string | null }[] }[];
  content?: { posts: { slug: string; title: string; excerpt: string | null }[]; pages: { slug: string; title: string }[] };
  redirectTo?: string;
};
type StoreCurrency = { code: string; name: string; displayAvailable: boolean; rate: { provider: string; sourceDate: string; fetchedAt: string; freshness: string } | null };
type NewsletterStatus = { available: boolean; enabledForPlan: boolean; deliveryAvailable: boolean; message: string };

export function Storefront({ slug }: { slug: string }) {
  const [store, setStore] = useState<StorefrontData | null>(null);
  const [error, setError] = useState('');
  const [currencies, setCurrencies] = useState<StoreCurrency[]>([]);
  const [displayCurrency, setDisplayCurrency] = useState('');
  const [displayAmounts, setDisplayAmounts] = useState<Record<string, number>>({});
  const [rateDescription, setRateDescription] = useState('');
  const [currencyError, setCurrencyError] = useState('');
  const [newsletter, setNewsletter] = useState<NewsletterStatus | null>(null);
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterBusy, setNewsletterBusy] = useState(false);
  const [newsletterMessage, setNewsletterMessage] = useState('');
  const [newsletterError, setNewsletterError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/stores/${encodeURIComponent(slug)}`, { credentials: 'include' }).then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? 'Store not found'); return body as StorefrontData; }),
      fetch(`/api/stores/${encodeURIComponent(slug)}/content`, { credentials: 'include' }).then(async response => response.ok ? response.json() : { posts: [], pages: [] }),
      fetch(`/api/stores/${encodeURIComponent(slug)}/currencies`, { credentials: 'include' }).then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? 'Store currencies unavailable'); return body as { baseCurrency: string; currencies: StoreCurrency[] }; })
    ])
      .then(([body, content, currencyData]) => {
        if (!active) return;
        if (body.redirectTo) {
          window.history.replaceState({}, '', body.redirectTo);
          window.location.reload();
          return;
        }
        document.title = `${body.name} | Market Lane`;
        setStore({ ...body, content });
        setCurrencies(currencyData.currencies.filter(currency => currency.displayAvailable));
        setDisplayCurrency(currencyData.baseCurrency);
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Store not found'); });
    return () => { active = false; };
  }, [slug]);

  useEffect(() => {
    let active = true;
    fetch(`/api/stores/${encodeURIComponent(slug)}/newsletter/status`, { credentials: 'include' })
      .then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? 'Newsletter status unavailable'); return body as NewsletterStatus; })
      .then(body => { if (active) setNewsletter(body); })
      .catch(() => { if (active) setNewsletter(null); });
    return () => { active = false; };
  }, [slug]);

  const subscribe = async (event: React.FormEvent) => {
    event.preventDefault(); setNewsletterBusy(true); setNewsletterError(''); setNewsletterMessage('');
    try {
      const response = await fetch(`/api/stores/${encodeURIComponent(slug)}/newsletter`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newsletterEmail, consent: newsletterConsent, consentSource: 'storefront' }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'We could not process your request.');
      setNewsletterMessage(body.message ?? 'Check your inbox for a confirmation link.'); setNewsletterEmail(''); setNewsletterConsent(false);
    } catch (reason) { setNewsletterError(reason instanceof Error ? reason.message : 'We could not process your request.'); }
    finally { setNewsletterBusy(false); }
  };

  useEffect(() => {
    if (!store || !displayCurrency) return;
    let active = true;
    setCurrencyError('');
    fetch(`/api/stores/${encodeURIComponent(slug)}/currency-preview?currency=${encodeURIComponent(displayCurrency)}`, { credentials: 'include' })
      .then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? 'A current display estimate is unavailable.'); return body as { currency: string; items: { productId: string; estimatedAmountMinor: number; rate: { provider: string; sourceDate: string; fetchedAt: string } }[]; note: string }; })
      .then(body => { if (!active) return; setDisplayAmounts(Object.fromEntries(body.items.map(item => [item.productId, item.estimatedAmountMinor]))); const sample = body.items[0]?.rate; setRateDescription(sample ? `${sample.provider === 'MANUAL' ? 'Store reference rate' : 'Reference rate'} observed ${sample.sourceDate}; fetched ${new Date(sample.fetchedAt).toLocaleString()}.` : `Prices shown in the Store's listing currency (${body.currency}).`); })
      .catch(reason => { if (active) { setDisplayAmounts({}); setCurrencyError(reason instanceof Error ? reason.message : 'Display estimate unavailable.'); } });
    return () => { active = false; };
  }, [slug, store, displayCurrency]);

  useEffect(() => {
    const faviconId = store?.theme.faviconMediaId;
    let link = document.querySelector<HTMLLinkElement>('link[data-store-branding-icon]');
    if (typeof faviconId !== 'string') {
      link?.remove();
      return undefined;
    }
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.storeBrandingIcon = 'true';
      document.head.append(link);
    }
    link.type = 'image/webp';
    link.href = `/content-media/${encodeURIComponent(faviconId)}`;
    return () => { document.querySelector('link[data-store-branding-icon]')?.remove(); };
  }, [store?.theme.faviconMediaId]);

  if (error) return <section className="page"><p className="eyebrow">Storefront</p><h1>Store not found</h1><p className="muted">This store is unavailable or its seller is not approved.</p></section>;
  if (!store) return <section className="page"><p className="eyebrow">Storefront</p><h1>Loading store…</h1></section>;

  return <section className="page storeFront" data-store-theme={store.theme.themePreset} data-mobile-template={store.theme.mobileTemplate} style={{ ['--store-primary' as string]: store.theme.primaryColor, ['--store-accent' as string]: store.theme.accentColor }}>
    {store.theme.bannerMediaId && <img className="storefrontBanner" src={`/content-media/${encodeURIComponent(store.theme.bannerMediaId)}`} alt={`${store.name} store banner`} />}
    <div className="storefrontIdentity">{store.theme.logoMediaId && <img className="storefrontLogo" src={`/content-media/${encodeURIComponent(store.theme.logoMediaId)}`} alt={`${store.name} logo`} />}<div><p className="eyebrow">Independent store</p><h1>{store.name}</h1></div></div>
    {store.theme.description && <p className="storeDescription">{store.theme.description}</p>}
    <div className="heroPills"><span>Approved products</span><span>Server-validated stock</span></div>
    <div className="sectionHeading"><h2>Products</h2>{currencies.length > 1 && <label>Display currency<select aria-label="Store display currency" value={displayCurrency} onChange={event => setDisplayCurrency(event.target.value)}>{currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>}</div>
    {displayCurrency !== store.products[0]?.currency && rateDescription && <p className="muted">Estimated display prices · {rateDescription} These are not payment conversion rates.</p>}
    {currencyError && <p className="notice" role="status">{currencyError} Listing prices remain available in their original currency.</p>}
    <div className="grid">{store.products.map(product => { const image = product.images?.[0] ?? product.mediaAttachments?.find(media => media.kind === 'IMAGE'); const sale = product.salePriceMinor != null && product.salePriceMinor < product.priceMinor; return <article className="card productCard" key={product.id}>{image ? <a href={`/products/${product.id}`}><img src={image.url} alt={'alt' in image ? image.alt : image.label || product.name} /></a> : <a className="productVisual productVisualFallback" href={`/products/${product.id}`} aria-label={`View ${product.name}`}><span>{product.name.slice(0, 1)}</span></a>}<div className="cardBody"><p className="eyebrow">{product.category?.name ?? 'Product'}</p><h2><a href={`/products/${product.id}`}>{product.name}</a></h2><p>{product.description}</p><div className="cardBottom"><strong>{displayAmounts[product.id] !== undefined && !currencyError ? formatMinor(displayAmounts[product.id]!, displayCurrency) : formatMinor(sale ? product.salePriceMinor! : product.priceMinor, product.currency)}</strong><span>{product.availableStock} in stock</span></div>{sale && <small>{displayCurrency === product.currency || displayAmounts[product.id] === undefined ? <del>{formatMinor(product.priceMinor, product.currency)}</del> : `Sale · regular ${formatMinor(product.priceMinor, product.currency)}`}</small>}{displayCurrency !== product.currency && displayAmounts[product.id] !== undefined && <small>Reference estimate only · listing currency {product.currency}</small>}</div></article>; })}</div>
    {store.products.length === 0 && <div className="empty">This store has no approved products available.</div>}
    {newsletter?.available && <section className="card cardBody storeNewsletter"><p className="eyebrow">From {store.name}</p><h2>Get store updates</h2><p className="muted">Optional email updates from this Store. Confirm your address before any marketing email is sent; unsubscribe at any time.</p><form onSubmit={subscribe}><label>Email address<input type="email" autoComplete="email" maxLength={254} required value={newsletterEmail} onChange={event => setNewsletterEmail(event.target.value)} /></label><label className="storePlanCheck"><input type="checkbox" required checked={newsletterConsent} onChange={event => setNewsletterConsent(event.target.checked)} />I agree to receive optional email updates from {store.name}. I can unsubscribe at any time.</label><button className="primary" disabled={newsletterBusy || !newsletterConsent}>{newsletterBusy ? 'Submitting…' : 'Send confirmation email'}</button></form>{newsletterError && <p className="notice" role="alert">{newsletterError}</p>}{newsletterMessage && <p className="notice" role="status">{newsletterMessage}</p>}</section>}
    {((store.content?.posts.length ?? 0) + (store.content?.pages.length ?? 0)) > 0 && <section className="storeContentLinks"><h2>From this store</h2>{store.content?.pages.map(page => <p key={`page-${page.slug}`}><a href={`/store/${store.slug}/pages/${page.slug}`}>{page.title}</a></p>)}{store.content?.posts.map(post => <article className="card cardBody" key={`post-${post.slug}`}><h3><a href={`/store/${store.slug}/blog/${post.slug}`}>{post.title}</a></h3>{post.excerpt && <p>{post.excerpt}</p>}</article>)}</section>}
  </section>;
}
