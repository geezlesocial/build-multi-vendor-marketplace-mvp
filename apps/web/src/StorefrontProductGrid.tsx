import { formatMinor } from "./money.js";
import { ProductCardActions } from "./ProductCardActions.js";

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
  variants?: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
    stock: number;
  }[];
  images?: { url: string; alt: string }[];
  mediaAttachments?: {
    kind: string;
    url: string;
    label?: string | null;
  }[];
};

type StorefrontProductGridProps = {
  products: readonly StorefrontProduct[];
  displayAmounts: Record<string, number>;
  displayCurrency: string;
  currencyError: string;
};

export function StorefrontProductGrid({
  products,
  displayAmounts,
  displayCurrency,
  currencyError,
}: StorefrontProductGridProps) {
  return (
    <div className="grid storefrontProductGrid">
      {products.map((product) => {
        const image =
          product.images?.[0] ??
          product.mediaAttachments?.find((media) => media.kind === "IMAGE");
        const sale =
          product.salePriceMinor != null &&
          product.salePriceMinor < product.priceMinor;
        return (
          <article
            className="card productCard storefrontProductCard"
            key={product.id}
          >
            {image ? (
              <a href={`/products/${product.id}`}>
                <img
                  src={image.url}
                  alt={"alt" in image ? image.alt : image.label || product.name}
                />
              </a>
            ) : (
              <a
                className="productVisual productVisualFallback"
                href={`/products/${product.id}`}
                aria-label={`View ${product.name}`}
              >
                <span>{product.name.slice(0, 1)}</span>
              </a>
            )}
            <div className="cardBody">
              <p className="eyebrow">{product.category?.name ?? "Product"}</p>
              <h2>
                <a href={`/products/${product.id}`}>{product.name}</a>
              </h2>
              <p>{product.description}</p>
              {product.wholesaleEnabled && (
                <small className="wholesaleLabel">
                  Wholesale · order {product.wholesaleMinQuantity}–
                  {product.wholesaleMaxQuantity} units
                </small>
              )}
              <div className="cardBottom">
                <strong>
                  {displayAmounts[product.id] !== undefined && !currencyError
                    ? formatMinor(displayAmounts[product.id]!, displayCurrency)
                    : formatMinor(
                        sale ? product.salePriceMinor! : product.priceMinor,
                        product.currency,
                      )}
                </strong>
                <span>{product.availableStock} in stock</span>
              </div>
              {sale && (
                <small>
                  {displayCurrency === product.currency ||
                  displayAmounts[product.id] === undefined ? (
                    <del>
                      {formatMinor(product.priceMinor, product.currency)}
                    </del>
                  ) : (
                    `Sale · regular ${formatMinor(product.priceMinor, product.currency)}`
                  )}
                </small>
              )}
              {displayCurrency !== product.currency &&
                displayAmounts[product.id] !== undefined && (
                  <small>
                    Reference estimate only · listing currency{" "}
                    {product.currency}
                  </small>
                )}
              <ProductCardActions
                productId={product.id}
                productName={product.name}
                availableStock={product.availableStock}
                hasSeller
                wholesaleMinQuantity={
                  product.wholesaleEnabled ? product.wholesaleMinQuantity : null
                }
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}
