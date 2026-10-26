type PlainRecord = Record<string, unknown>;

function asRecord(value: unknown): PlainRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PlainRecord : null;
}

export function publicLiveSession<T extends { providerSessionRef?: string | null; playbackRef?: string | null; providerStatus?: unknown; errorMessage?: unknown }>(session: T) {
  const source = session as T & { seller?: unknown; products?: unknown };
  const { providerSessionRef: _providerSessionRef, playbackRef, providerStatus: _providerStatus, errorMessage: _errorMessage, seller, products, ...safe } = source;
  const sellerRecord = asRecord(seller);
  const storeRecord = asRecord(sellerRecord?.store);
  const safeSeller = sellerRecord ? { store: storeRecord ? { name: storeRecord.name, slug: storeRecord.slug } : null } : seller;
  const safeProducts = Array.isArray(products) ? products.map(value => {
    const link = asRecord(value);
    if (!link) return null;
    const product = asRecord(link.product);
    const inventory = asRecord(product?.inventory);
    return {
      id: link.id,
      productId: link.productId,
      sortOrder: link.sortOrder,
      featured: link.featured,
      ...(product ? { product: {
        id: product.id,
        name: product.name,
        description: product.description,
        priceMinor: product.priceMinor,
        salePriceMinor: product.salePriceMinor,
        currency: product.currency,
        availableStock: product.availableStock ?? inventory?.quantity ?? 0
      } } : {})
    };
  }).filter(Boolean) : products;
  const playbackUrl = safePlaybackUrl(playbackRef);
  const realtimeAvailable = typeof playbackRef === 'string' && playbackRef.startsWith('marketplace-live-');
  return {
    ...safe,
    ...(seller !== undefined ? { seller: safeSeller } : {}),
    ...(products !== undefined ? { products: safeProducts } : {}),
    playbackAvailable: Boolean(playbackUrl || realtimeAvailable),
    realtimeAvailable,
    ...(playbackUrl ? { playbackUrl } : {})
  };
}

function safePlaybackUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
    return url.toString();
  } catch { return null; }
}
