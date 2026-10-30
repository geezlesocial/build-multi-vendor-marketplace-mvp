import { useEffect, useState } from 'react';
import { formatMinor } from './money.js';
import { ProductCardActions } from './ProductCardActions.js';
import './JimaRecommendations.css';

type Placement = 'home' | 'product' | 'store' | 'widget';
type Recommendation = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  inventory: { quantity: number } | null;
  category: { name: string } | null;
  images: { url: string; alt: string }[];
  seller: { store: { name: string; slug: string } | null } | null;
};
type RecommendationResponse = { items: Recommendation[]; personalized: boolean; disabled: boolean };

const titleByPlacement: Record<Placement, string> = {
  home: 'Recommended by Jima AI',
  product: 'More finds you may like',
  store: 'Explore more of the marketplace',
  widget: 'A few marketplace finds'
};

export function JimaRecommendations({ placement }: { placement: Placement }) {
  const [result, setResult] = useState<RecommendationResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    fetch(`/api/ai/recommendations?placement=${placement}`, { credentials: 'include' })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Jima recommendations are temporarily unavailable.');
        return body as RecommendationResponse;
      })
      .then(body => { if (active) setResult(body); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Jima recommendations are temporarily unavailable.'); });
    return () => { active = false; };
  }, [placement, retry]);

  useEffect(() => {
    const refreshFromFavorite = () => setRetry(value => value + 1);
    window.addEventListener('marketplace:favorite-changed', refreshFromFavorite);
    return () => window.removeEventListener('marketplace:favorite-changed', refreshFromFavorite);
  }, []);

  if (result?.disabled) return null;
  if (!result && !error) return <section className={`jimaRecommendationSection jimaRecommendation-${placement}`} aria-label={titleByPlacement[placement]}><p className="muted" role="status" aria-busy="true">Loading marketplace recommendations…</p></section>;
  if (error) return <section className={`jimaRecommendationSection jimaRecommendation-${placement}`} aria-label={titleByPlacement[placement]}><p className="muted" role="status">Recommendations are temporarily unavailable. Marketplace browsing is unaffected.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></section>;
  if (!result?.items.length) return null;

  return <section className={`jimaRecommendationSection jimaRecommendation-${placement}`} aria-labelledby={`jima-recommendations-${placement}`}>
    <header><div><p className="eyebrow">Organic discovery · not sponsored</p><h2 id={`jima-recommendations-${placement}`}>{titleByPlacement[placement]}</h2><p className="muted">{result.personalized ? 'Personalized with your consented interests, including categories from products you like.' : 'Selected from approved, in-stock marketplace products.'}</p></div></header>
    <div className="jimaRecommendationGrid">{result.items.map(item => {
      const image = item.images[0];
      const store = item.seller?.store;
      const price = item.salePriceMinor != null && item.salePriceMinor < item.priceMinor ? item.salePriceMinor : item.priceMinor;
      return <article className="card productCard jimaRecommendationCard" key={item.id}>
        {image ? <a href={`/products/${encodeURIComponent(item.id)}`}><img src={image.url} alt={image.alt || item.name} loading="lazy" /></a> : <a className="productVisual productVisualFallback" href={`/products/${encodeURIComponent(item.id)}`} aria-label={`View ${item.name}`}><span className="productVisualLabel">{item.category?.name ?? 'Marketplace find'}</span></a>}
        <div className="cardBody"><p className="eyebrow">{store ? <a href={`/store/${encodeURIComponent(store.slug)}`}>{store.name}</a> : 'Official platform store'}</p><h3><a href={`/products/${encodeURIComponent(item.id)}`}>{item.name}</a></h3><p>{item.description}</p><div className="cardBottom"><strong>{formatMinor(price, item.currency)}</strong><a className="heroActionSecondary" href={`/products/${encodeURIComponent(item.id)}`}>View product</a></div><small>{item.inventory?.quantity ?? 0} available · {item.currency}</small><ProductCardActions productId={item.id} productName={item.name} availableStock={item.inventory?.quantity ?? 0} hasSeller={Boolean(store)} /></div>
      </article>;
    })}</div>
  </section>;
}
