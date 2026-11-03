import React from "react";
import { formatMinor } from "./money.js";
import type {
  CatalogTheme,
  Theme,
  ThemePreviewProduct,
  ThemePreset,
} from "./store-theme-types.js";

export function themeContrastRatio(first: string, second: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5]
      .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return (
      0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    );
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

export function StoreThemeArtwork({
  preset,
  name,
  src,
}: {
  preset: ThemePreset;
  name: string;
  src: string;
}) {
  return (
    <figure className="themeArtwork" data-theme={preset}>
      <img
        src={src}
        alt={`${name} storefront theme preview`}
        loading="lazy"
        decoding="async"
      />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

export function StoreThemePreview({
  preset,
  theme,
  catalog,
  storeName,
  device,
  products,
}: {
  preset: ThemePreset;
  theme: Theme;
  catalog: CatalogTheme[];
  storeName: string;
  device: string;
  products: ThemePreviewProduct[];
}) {
  const meta = catalog.find((item) => item.id === preset);
  const tokens = meta?.defaultTokens;
  return (
    <div
      className={`themePreviewFrame themePreviewFrame--${device}`}
      data-theme={preset}
      style={
        {
          "--preview-surface": tokens?.surfaceColor,
          "--preview-card": tokens?.cardColor,
          "--preview-ink": tokens?.textColor,
          "--preview-muted": tokens?.mutedColor,
          "--preview-accent": theme.accentColor,
          "--preview-primary": theme.primaryColor,
        } as React.CSSProperties
      }
    >
      <div className="themePreviewTop">
        <strong>{storeName || "Your Store"}</strong>
        <span>Search products</span>
        <small>Cart</small>
      </div>
      {meta && (
        <img
          className="themePreviewReferenceImage"
          src={meta.previewImageUrl}
          alt={`${meta.name} theme reference preview`}
          loading="lazy"
          decoding="async"
        />
      )}
      <div className="themePreviewHero">
        {theme.bannerMediaId && (
          <span className="themePreviewImageMark">Store banner selected</span>
        )}
        <small>PRIVATE PREVIEW · NOT PUBLISHED</small>
        <h3>
          {theme.heroTitle ||
            (preset === "EDITORIAL"
              ? "A story worth discovering"
              : preset === "GROCERIES"
                ? "Browse fresh departments"
                : preset === "TECH_ELECTRONICS"
                  ? "Find your next upgrade"
                  : storeName || "Welcome to your Store")}
        </h3>
        <p>{theme.heroSubtitle || theme.description || meta?.description}</p>
        {theme.heroButtonLabel && (
          <button type="button" disabled>
            {theme.heroButtonLabel}
          </button>
        )}
      </div>
      {products.length > 0 && (
        <div className="themePreviewCategories">
          {[
            ...new Map(
              products.flatMap((product) =>
                product.category
                  ? [[product.category.slug, product.category.name] as const]
                  : [],
              ),
            ).values(),
          ]
            .slice(0, 4)
            .map((category) => (
              <span key={category}>{category}</span>
            ))}
        </div>
      )}
      {theme.sections
        .filter((section) => section.visible)
        .map((section, index) => (
          <section
            className="themePreviewSection"
            key={`${section.type}-${index}`}
          >
            <strong>{section.title || section.type}</strong>
            <span>
              {section.type === "categories"
                ? `${[...new Set(products.map((product) => product.category?.slug).filter(Boolean))].length} approved categories`
                : section.type === "promotion"
                  ? "Current sale listings"
                  : section.type === "brandHighlights"
                    ? "Brand and feature data from approved listings"
                    : `${section.productIds.length || products.length} approved product tiles`}
            </span>
          </section>
        ))}
      {products.length > 0 ? (
        <div className="themePreviewProducts">
          {products.slice(0, 3).map((product) => {
            const sale =
              product.salePriceMinor != null &&
              product.salePriceMinor < product.priceMinor;
            return (
              <article key={product.id}>
                {product.images[0] && (
                  <img
                    src={product.images[0].url}
                    alt={product.images[0].alt || product.name}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <strong>{product.name}</strong>
                <small>
                  {formatMinor(
                    sale ? product.salePriceMinor! : product.priceMinor,
                    product.currency,
                  )}{" "}
                  · {product.availableStock} in stock
                </small>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="themePreviewEmpty">
          Approved product imagery and prices will appear here when your Store
          has approved listings.
        </p>
      )}
    </div>
  );
}
