import React, { useEffect, useState } from 'react';
import { formatMinor } from './money.js';

type Product = { id: string; name: string; slug: string; description: string; priceMinor: number; currency: string; availableStock: number; images?: { url: string; alt: string }[]; seller?: { store?: { name: string; slug: string } } };
const money = (minor: number, currency: string) => formatMinor(minor, currency);

export function ProductPage({ id }: { id: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { let active = true; fetch(`/api/products/${encodeURIComponent(id)}`).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Product unavailable'); if (!active) return; setProduct(body); const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1]; void fetch('/api/store-buster/signals', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ type: 'PRODUCT_VIEW', productId: body.id }) }).catch(() => undefined); }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [id]);
  const add = async () => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('marketplace_csrf='))?.split('=')[1];
    const response = await fetch('/api/cart/items', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify({ productId: id, quantity: 1 }) });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.assign('/?signin=required'); return; }
    if (!response.ok) throw new Error(body.error ?? 'Could not add to cart');
    setMessage('Added to cart.');
  };
  if (!product) return <section className="page"><h1>{message || 'Loading product…'}</h1>{message && <a className="primary" href="/">Back to marketplace</a>}</section>;
  return <section className="page productDetail"><a href="/" className="muted">← Back to marketplace</a><div className="productDetailGrid">{product.images?.[0] ? <img src={product.images[0].url} alt={product.images[0].alt} /> : <div className="productMark productHeroMark" aria-hidden="true">{product.name.slice(0, 1)}</div>}<div><p className="eyebrow">Product · {product.seller?.store ? <a href={`/store/${product.seller.store.slug}`}>{product.seller.store.name}</a> : 'Platform store'}</p><h1>{product.name}</h1><p>{product.description}</p><strong className="productPrice">{money(product.priceMinor, product.currency)}</strong><p className="muted">{product.availableStock} available · Checkout uses the platform base currency.</p><button className="primary" disabled={!product.availableStock} onClick={() => add().catch(error => setMessage(error.message))}>{product.availableStock ? 'Add to cart' : 'Out of stock'}</button>{message && <p className="notice" role="status">{message}</p>}</div></div></section>;
}
