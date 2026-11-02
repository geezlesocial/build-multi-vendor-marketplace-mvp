import React from "react";

type Preset =
  | "CLASSIC"
  | "EDITORIAL"
  | "BOUTIQUE"
  | "TECH_ELECTRONICS"
  | "GROCERIES"
  | "ECOMMERCE_MARKETPLACE";
type Category = { name: string; slug: string };
type Product = {
  name: string;
  availableStock: number;
  category: Category | null;
  brand?: { name: string } | null;
  features?: { name: string }[];
  images?: { url: string; alt: string }[];
};
type Theme = {
  themePreset: Preset;
  description: string;
  heroTitle: string;
  heroSubtitle: string;
  heroButtonLabel: string;
  heroButtonHref: string;
  bannerMediaId: string | null;
};

export function StorefrontThemeIntro({
  storeName,
  theme,
  products,
}: {
  storeName: string;
  theme: Theme;
  products: Product[];
}) {
  const brands = [
    ...new Set(
      products
        .map((product) => product.brand?.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ].slice(0, 5);
  const features = [
    ...new Set(
      products.flatMap(
        (product) => product.features?.map((feature) => feature.name) ?? [],
      ),
    ),
  ].slice(0, 6);
  const bannerUrl = theme.bannerMediaId
    ? `/content-media/${encodeURIComponent(theme.bannerMediaId)}`
    : products.find((product) => product.images?.[0])?.images?.[0]?.url;
  const title = theme.heroTitle || storeName;
  const subtitle = theme.heroSubtitle || theme.description;
  const cta =
    theme.heroButtonLabel && theme.heroButtonHref ? (
      <a className="primary" href={theme.heroButtonHref}>
        {theme.heroButtonLabel}
      </a>
    ) : null;

  if (theme.themePreset === "EDITORIAL")
    return (
      <section className="storefrontThemeIntro storefrontThemeIntro--editorial">
        <div>
          <p className="eyebrow">The Store journal · collections</p>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
          {cta}
        </div>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt={
              theme.bannerMediaId
                ? `${storeName} store banner`
                : `${products.find((product) => product.images?.[0])?.name ?? "Featured product"} from ${storeName}`
            }
            loading="lazy"
            decoding="async"
          />
        )}
      </section>
    );

  if (theme.themePreset === "BOUTIQUE")
    return (
      <section className="storefrontThemeIntro storefrontThemeIntro--boutique">
        <div>
          <p className="eyebrow">Curated by {storeName}</p>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
          {cta}
        </div>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt={
              theme.bannerMediaId
                ? `${storeName} store banner`
                : `${products.find((product) => product.images?.[0])?.name ?? "Featured product"} from ${storeName}`
            }
            loading="lazy"
            decoding="async"
          />
        )}
      </section>
    );

  if (theme.themePreset === "TECH_ELECTRONICS")
    return (
      <section className="storefrontThemeIntro storefrontThemeIntro--tech">
        <div>
          <p className="eyebrow">Verified catalog · current availability</p>
          <h1>{title || "Explore products and features"}</h1>
          {subtitle && <p>{subtitle}</p>}
          {features.length > 0 && (
            <div
              className="storefrontTechFeatures"
              aria-label="Product features from current listings"
            >
              {features.map((feature) => (
                <span key={feature}>{feature}</span>
              ))}
            </div>
          )}
          {brands.length > 0 && (
            <p className="storefrontThemeBrands">
              Brands in this Store: {brands.join(" · ")}
            </p>
          )}
          {cta}
        </div>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt={
              theme.bannerMediaId
                ? `${storeName} store banner`
                : `${products.find((product) => product.images?.[0])?.name ?? "Featured product"} from ${storeName}`
            }
            loading="lazy"
            decoding="async"
          />
        )}
      </section>
    );

  if (theme.themePreset === "GROCERIES")
    return (
      <section className="storefrontThemeIntro storefrontThemeIntro--groceries">
        <div>
          <p className="eyebrow">Store departments</p>
          <h1>{title || "Browse available products"}</h1>
          {subtitle && <p>{subtitle}</p>}
          <p className="storefrontAvailability">
            {products.filter((product) => product.availableStock > 0).length}{" "}
            products currently in stock
          </p>
          {cta}
        </div>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt={
              theme.bannerMediaId
                ? `${storeName} store banner`
                : `${products.find((product) => product.images?.[0])?.name ?? "Featured product"} from ${storeName}`
            }
            loading="lazy"
            decoding="async"
          />
        )}
      </section>
    );

  if (theme.themePreset === "ECOMMERCE_MARKETPLACE")
    return (
      <section className="storefrontThemeIntro storefrontThemeIntro--marketplace">
        <div>
          <p className="eyebrow">{storeName} · approved Store catalog</p>
          <h1>{title || "Find what you are looking for"}</h1>
          {subtitle && <p>{subtitle}</p>}
          <p className="storefrontAvailability">
            {products.length} approved listings · one independent Store
          </p>
          {cta}
        </div>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt={
              theme.bannerMediaId
                ? `${storeName} store banner`
                : `${products.find((product) => product.images?.[0])?.name ?? "Featured product"} from ${storeName}`
            }
            loading="lazy"
            decoding="async"
          />
        )}
      </section>
    );

  return (
    <section className="storefrontThemeIntro storefrontThemeIntro--classic">
      <div>
        <p className="eyebrow">Independent Store · approved catalog</p>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {cta}
      </div>
    </section>
  );
}

export function StorefrontCategoryNav({
  products,
  selectedCategory,
  onCategory,
}: {
  products: Product[];
  selectedCategory: string;
  onCategory: (slug: string) => void;
}) {
  const categories = new Map<string, Category>();
  for (const product of products)
    if (product.category)
      categories.set(product.category.slug, product.category);
  if (categories.size === 0) return null;
  return (
    <nav
      className="storefrontThemeCategories"
      aria-label="Filter by Store category"
    >
      <button
        type="button"
        className={!selectedCategory ? "active" : ""}
        aria-pressed={!selectedCategory}
        onClick={() => onCategory("")}
      >
        All products
      </button>
      {[...categories.values()].slice(0, 10).map((category) => (
        <button
          type="button"
          key={category.slug}
          className={selectedCategory === category.slug ? "active" : ""}
          aria-pressed={selectedCategory === category.slug}
          onClick={() => onCategory(category.slug)}
        >
          {category.name}
        </button>
      ))}
    </nav>
  );
}
