import { useState } from "react";
import { formatMinor } from "./money.js";
import { ProductCardActions } from "./ProductCardActions.js";
import {
  ProductMediaGallery,
  type ProductGalleryItem,
  type PublicProductVariant,
} from "./ProductMediaGallery.js";
import { ProductVariantSelect } from "./ProductVariantSelect.js";

export type MarketplaceProductCardData = {
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
  image?: { url: string; alt: string } | null;
  gallery?: ProductGalleryItem[];
  variants?: PublicProductVariant[];
  category?: { name: string; slug?: string } | null;
  store?: { name: string; slug: string } | null;
};

export function MarketplaceProductCard({
  product,
  categoryLabel,
  onAdd,
  onSignIn,
}: {
  product: MarketplaceProductCardData;
  categoryLabel?: string;
  onAdd: (productId: string, quantity: number, variantId?: string) => void;
  onSignIn: () => void;
}) {
  const [variantId, setVariantId] = useState("");
  const variants = product.variants ?? [];
  const variant = variants.find((item) => item.id === variantId) ?? null;
  const stock = variants.length
    ? (variant?.stock ?? 0)
    : product.availableStock;
  const minQuantity = product.wholesaleEnabled
    ? (product.wholesaleMinQuantity ?? 1)
    : 1;
  const price =
    variant?.priceMinor ?? product.salePriceMinor ?? product.priceMinor;
  const currency = variant?.currency ?? product.currency;
  const gallery = product.gallery?.length
    ? product.gallery
    : product.image
      ? [
          {
            id: product.image.url,
            kind: "IMAGE",
            url: product.image.url,
            alt: product.image.alt,
          },
        ]
      : [];

  return (
    <article className="card productCard marketplaceProductCard">
      <ProductMediaGallery
        compact
        productName={product.name}
        media={gallery}
        variantImage={variant?.image}
      />
      <div className="cardBody">
        <p className="eyebrow">
          {categoryLabel ?? product.store?.name ?? "Marketplace product"}
        </p>
        <h3>
          <a href={`/products/${encodeURIComponent(product.id)}`}>
            {product.name}
          </a>
        </h3>
        <p>{product.description}</p>
        {product.wholesaleEnabled && (
          <small className="wholesaleLabel">
            Wholesale · order {product.wholesaleMinQuantity}–
            {product.wholesaleMaxQuantity} units
          </small>
        )}
        <ProductVariantSelect
          productName={product.name}
          variants={variants}
          value={variantId}
          onChange={setVariantId}
        />
        <div className="cardBottom">
          <strong>{formatMinor(price, currency)}</strong>
          <button
            type="button"
            disabled={stock < minQuantity || (variants.length > 0 && !variant)}
            onClick={() =>
              variant
                ? onAdd(product.id, minQuantity, variant.id)
                : variants.length
                  ? onSignIn()
                  : onAdd(product.id, minQuantity)
            }
          >
            {variants.length > 0 && !variant
              ? "Choose an option"
              : stock >= minQuantity
                ? "Add to cart"
                : "Out of stock"}
          </button>
        </div>
        {!variant && product.salePriceMinor != null && (
          <small>
            <del>{formatMinor(product.priceMinor, product.currency)}</del> ·
            Sale price
          </small>
        )}
        <small>
          {stock} available{variant ? ` · ${variant.name}` : ""}
        </small>
        {product.store && (
          <p>
            <a href={`/store/${encodeURIComponent(product.store.slug)}`}>
              Visit {product.store.name}
            </a>
          </p>
        )}
        <ProductCardActions
          productId={product.id}
          productName={product.name}
          availableStock={stock}
          variantId={variant?.id}
          requiresVariantSelection={variants.length > 0}
          hasSeller={Boolean(product.store)}
          wholesaleMinQuantity={
            product.wholesaleEnabled ? product.wholesaleMinQuantity : null
          }
          onSignIn={onSignIn}
        />
      </div>
    </article>
  );
}
