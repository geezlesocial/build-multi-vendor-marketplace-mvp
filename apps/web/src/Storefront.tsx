import React, { useEffect, useState } from 'react';

type StorefrontData = {
  name: string;
  slug: string;
  publicPath: string;
  theme: { themePreset: string; mobileTemplate: string; description: string; primaryColor: string; accentColor: string; font: string; bannerMediaId: string | null };
  products: { id: string; name: string; description: string; priceMinor: number; currency: string; availableStock: number; category: { name: string } | null }[];
  redirectTo?: string;
};

const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);

export function Storefront({ slug }: { slug: string }) {
  const [store, setStore] = useState<StorefrontData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/stores/${encodeURIComponent(slug)}`, { credentials: 'include' })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Store not found');
        return body as StorefrontData;
      })
      .then(body => {
        if (!active) return;
        if (body.redirectTo) {
          window.history.replaceState({}, '', body.redirectTo);
          window.location.reload();
          return;
        }
        document.title = `${body.name} | Market Lane`;
        setStore(body);
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Store not found'); });
    return () => { active = false; };
  }, [slug]);

  if (error) return <section className="page"><p className="eyebrow">Storefront</p><h1>Store not found</h1><p className="muted">This store is unavailable or its seller is not approved.</p></section>;
  if (!store) return <section className="page"><p className="eyebrow">Storefront</p><h1>Loading store…</h1></section>;

  return <section className="page storeFront" data-store-theme={store.theme.themePreset} data-mobile-template={store.theme.mobileTemplate} style={{ ['--store-primary' as string]: store.theme.primaryColor, ['--store-accent' as string]: store.theme.accentColor }}>
    <p className="eyebrow">Independent store</p>
    <h1>{store.name}</h1>
    {store.theme.description && <p className="storeDescription">{store.theme.description}</p>}
    <div className="heroPills"><span>Approved products</span><span>Server-validated stock</span></div>
    <h2>Products</h2>
    <div className="grid">{store.products.map(product => <article className="card" key={product.id}><div className="productMark">{product.name.slice(0, 1)}</div><div className="cardBody"><p className="eyebrow">{product.category?.name ?? 'Product'}</p><h2>{product.name}</h2><p>{product.description}</p><div className="cardBottom"><strong>{money(product.priceMinor, product.currency)}</strong><span>{product.availableStock} in stock</span></div></div></article>)}</div>
    {store.products.length === 0 && <div className="empty">This store has no approved products available.</div>}
  </section>;
}
