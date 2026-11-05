import { useState } from "react";
import { formatMinor } from "./money.js";
import { ProductCardActions } from "./ProductCardActions.js";
import { ProductMediaGallery, type ProductGalleryItem, type PublicProductVariant } from "./ProductMediaGallery.js";
import { ProductVariantSelect } from "./ProductVariantSelect.js";

export type StorefrontProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  salePriceMinor?: number | null;
  currency: string;
  availableStock: number;
  wholesaleEnabled?: boolean;
  wholesaleMinQuantity?: number | null;
  wholesaleMaxQuantity?: number | null;
  category: { name: string; slug: string } | null;
  brand?: { name: string; slug: string } | null;
  features?: { id: string; name: string }[];
  variants?: PublicProductVariant[];
  images?: { id?: string; url: string; alt: string }[];
  mediaAttachments?: {
    id?: string;
    kind: string;
    url: string;
    label?: string | null;
    originalName?: string;
    detectedMime?: string;
  }[];
};

type StorefrontProductGridProps = {
  products: readonly StorefrontProduct[];
  displayAmounts: Record<string, number>;
  displayCurrency: string;
  currencyError: string;
};

function StorefrontProductCard({
  product,
  displayAmounts,
  displayCurrency,
  currencyError,
}: StorefrontProductGridProps & { product: StorefrontProduct }) {
  const [variantId, setVariantId] = useState("");
  const variant = product.variants?.find((item) => item.id === variantId) ?? null;
  const variants = product.variants ?? [];
  const stock = variants.length ? variant?.stock ?? 0 : product.availableStock;
  const sale = !variant && product.salePriceMinor != null && product.salePriceMinor < product.priceMinor;
  const price = variant?.priceMinor ?? (sale ? product.salePriceMinor! : product.priceMinor);
  const currency = variant?.currency ?? product.currency;
  const displayAmount = !variant && displayAmounts[product.id] !== undefined && !currencyError
    ? displayAmounts[product.id]!
    : undefined;
  const media: ProductGalleryItem[] = [
    ...(product.images ?? []).map((image) => ({ id: image.id ?? image.url, kind: "IMAGE", url: image.url, alt: image.alt })),
    ...(product.mediaAttachments ?? []).map((item, index) => ({
      id: item.id ?? `${item.kind}-${index}`,
      kind: item.kind,
      url: item.url,
      label: item.label,
      originalName: item.originalName,
      detectedMime: item.detectedMime,
    })),
  ];

  return (
    <article className="card productCard storefrontProductCard">
      <ProductMediaGallery compact productName={product.name} media={media} variantImage={variant?.image} />
      <div className="cardBody">
        <p className="eyebrow">{product.category?.name ?? "Product"}</p>
        <h2><a href={`/products/${encodeURIComponent(product.id)}`}>{product.name}</a></h2>
        <p>{product.description}</p>
        {product.wholesaleEnabled && <small className="wholesaleLabel">Wholesale · order {product.wholesaleMinQuantity}–{product.wholesaleMaxQuantity} units</small>}
        <ProductVariantSelect productName={product.name} variants={variants} value={variantId} onChange={setVariantId} />
        <div className="cardBottom">
          <strong>{displayAmount !== undefined ? formatMinor(displayAmount, displayCurrency) : formatMinor(price, currency)}</strong>
          <span>{stock} in stock</span>
        </div>
        {sale && <small><del>{formatMinor(product.priceMinor, product.currency)}</del> · Sale price</small>}
        {displayCurrency !== currency && displayAmount !== undefined && <small>Reference estimate only · listing currency {currency}</small>}
        <ProductCardActions
          productId={product.id}
          productName={product.name}
          availableStock={stock}
          variantId={variant?.id}
          requiresVariantSelection={variants.length > 0}
          hasSeller
          wholesaleMinQuantity={product.wholesaleEnabled ? product.wholesaleMinQuantity : null}
        />
      </div>
    </article>
  );
}

export function StorefrontProductGrid(props: StorefrontProductGridProps) {
  return (
    <div className="grid storefrontProductGrid">
      {props.products.map((product) => (
        <StorefrontProductCard key={product.id} {...props} product={product} />
      ))}
    </div>
  );
}
