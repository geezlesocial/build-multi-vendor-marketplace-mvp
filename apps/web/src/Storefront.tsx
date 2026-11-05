import React, { useEffect, useState } from "react";
import { formatMinor } from "./money.js";
import { JimaRecommendations } from "./JimaRecommendations.js";
import { StoreSeoMetadata } from "./StoreSeoMetadata.js";
import { StoreContentLinks } from "./StoreContentLinks.js";
import {
  StorefrontProductGrid,
  type StorefrontProduct,
} from "./StorefrontProductGrid.js";
import { MarketplaceAdPlacementSection } from "./MarketplaceAds.js";
import { PublicCampaignPlacement } from "./PublicCampaigns.js";
import {
  StorefrontCategoryNav,
  StorefrontThemeIntro,
} from "./StorefrontThemeIntro.js";

type StorefrontData = {
  storeId: string;
  name: string;
  slug: string;
  publicPath: string;
  theme: {
    themePreset:
      | "CLASSIC"
      | "EDITORIAL"
      | "BOUTIQUE"
      | "TECH_ELECTRONICS"
      | "GROCERIES"
      | "ECOMMERCE_MARKETPLACE";
    mobileTemplate: string;
    description: string;
    heroTitle: string;
    heroSubtitle: string;
    heroButtonLabel: string;
    heroButtonHref: string;
    primaryColor: string;
    accentColor: string;
    font: string;
    gridDensity: string;
    cardStyle: string;
    sections: {
      type: string;
      title: string;
      visible: boolean;
      categorySlug: string | null;
      productIds: string[];
    }[];
    logoMediaId: string | null;
    faviconMediaId: string | null;
    bannerMediaId: string | null;
  };
  designTokens?: {
    surfaceColor: string;
    cardColor: string;
    textColor: string;
    mutedColor: string;
    accentColor: string;
  };
  publishedAt?: string | null;
  products: (StorefrontProduct & { slug: string })[];
  content?: {
    posts: { slug: string; title: string; excerpt: string | null }[];
    pages: { slug: string; title: string }[];
  };
  redirectTo?: string;
};
type StoreCurrency = {
  code: string;
  name: string;
  displayAvailable: boolean;
  rate: {
    provider: string;
    sourceDate: string;
    fetchedAt: string;
    freshness: string;
  } | null;
};
type NewsletterStatus = {
  available: boolean;
  enabledForPlan: boolean;
  deliveryAvailable: boolean;
  message: string;
};

export function Storefront({ slug }: { slug: string }) {
  const [store, setStore] = useState<StorefrontData | null>(null);
  const [error, setError] = useState("");
  const [currencies, setCurrencies] = useState<StoreCurrency[]>([]);
  const [displayCurrency, setDisplayCurrency] = useState("");
  const [searchTerm, setSearchTerm] = useState(
    () => new URLSearchParams(window.location.search).get("search") ?? "",
  );
  const [selectedCategory, setSelectedCategory] = useState("");
  const [productSort, setProductSort] = useState<
    "featured" | "name" | "price-asc" | "price-desc"
  >("featured");
  const [displayAmounts, setDisplayAmounts] = useState<Record<string, number>>(
    {},
  );
  const [rateDescription, setRateDescription] = useState("");
  const [currencyError, setCurrencyError] = useState("");
  const [newsletter, setNewsletter] = useState<NewsletterStatus | null>(null);
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterBusy, setNewsletterBusy] = useState(false);
  const [newsletterMessage, setNewsletterMessage] = useState("");
  const [newsletterError, setNewsletterError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/stores/${encodeURIComponent(slug)}`, {
        credentials: "include",
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "Store not found");
        return body as StorefrontData;
      }),
      fetch(`/api/stores/${encodeURIComponent(slug)}/content`, {
        credentials: "include",
      }).then(async (response) =>
        response.ok ? response.json() : { posts: [], pages: [] },
      ),
      fetch(`/api/stores/${encodeURIComponent(slug)}/currencies`, {
        credentials: "include",
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(body.error ?? "Store currencies unavailable");
        return body as { baseCurrency: string; currencies: StoreCurrency[] };
      }),
      fetch("/api/account/preferences", { credentials: "include" })
        .then(async (response) =>
          response.ok
            ? (response.json() as Promise<{
                preference?: { displayCurrency?: string };
              }>)
            : null,
        )
        .catch(() => null),
      fetch(`/api/stores/${encodeURIComponent(slug)}/variants`, { credentials: "include" })
        .then(async (response) => response.ok ? response.json() as Promise<{ productId: string; variants: StorefrontProduct["variants"] }[]> : [])
        .catch(() => [] as { productId: string; variants: StorefrontProduct["variants"] }[]),
    ])
      .then(([body, content, currencyData, preferenceData, variantRows]) => {
        if (!active) return;
        if (body.redirectTo) {
          window.history.replaceState({}, "", body.redirectTo);
          window.location.reload();
          return;
        }
        setStore({
          ...body,
          content,
          products: body.products.map((product) => ({
            ...product,
            variants: variantRows.find((row) => row.productId === product.id)?.variants ?? product.variants ?? [],
          })),
        });
        const availableCurrencies = currencyData.currencies.filter(
          (currency) => currency.displayAvailable,
        );
        setCurrencies(availableCurrencies);
        const preferredCurrency = preferenceData?.preference?.displayCurrency;
        setDisplayCurrency(
          preferredCurrency &&
            availableCurrencies.some(
              (currency) => currency.code === preferredCurrency,
            )
            ? preferredCurrency
            : currencyData.baseCurrency,
        );
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Store not found",
          );
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const loadedStoreId = store?.storeId;
  useEffect(() => {
    if (!loadedStoreId) return undefined;
    let active = true;
    const refreshTheme = () => {
      if (document.visibilityState === "hidden") return;
      fetch(`/api/stores/${encodeURIComponent(slug)}/theme`, {
        credentials: "include",
        cache: "no-store",
      })
        .then(async (response) =>
          response.ok
            ? (response.json() as Promise<{
                theme: StorefrontData["theme"];
                designTokens: StorefrontData["designTokens"];
                publishedAt: string | null;
              }>)
            : null,
        )
        .then((next) => {
          if (active && next)
            setStore((current) =>
              current && current.slug === slug
                ? {
                    ...current,
                    theme: next.theme,
                    designTokens: next.designTokens,
                    publishedAt: next.publishedAt,
                  }
                : current,
            );
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refreshTheme, 15_000);
    document.addEventListener("visibilitychange", refreshTheme);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshTheme);
    };
  }, [slug, loadedStoreId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/stores/${encodeURIComponent(slug)}/newsletter/status`, {
      credentials: "include",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(body.error ?? "Newsletter status unavailable");
        return body as NewsletterStatus;
      })
      .then((body) => {
        if (active) setNewsletter(body);
      })
      .catch(() => {
        if (active) setNewsletter(null);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const subscribe = async (event: React.FormEvent) => {
    event.preventDefault();
    setNewsletterBusy(true);
    setNewsletterError("");
    setNewsletterMessage("");
    try {
      const response = await fetch(
        `/api/stores/${encodeURIComponent(slug)}/newsletter`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: newsletterEmail,
            consent: newsletterConsent,
            consentSource: "storefront",
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error ?? "We could not process your request.");
      setNewsletterMessage(
        body.message ?? "Check your inbox for a confirmation link.",
      );
      setNewsletterEmail("");
      setNewsletterConsent(false);
    } catch (reason) {
      setNewsletterError(
        reason instanceof Error
          ? reason.message
          : "We could not process your request.",
      );
    } finally {
      setNewsletterBusy(false);
    }
  };

  useEffect(() => {
    if (!store || !displayCurrency) return;
    let active = true;
    setCurrencyError("");
    fetch(
      `/api/stores/${encodeURIComponent(slug)}/currency-preview?currency=${encodeURIComponent(displayCurrency)}`,
      { credentials: "include" },
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            body.error ?? "A current display estimate is unavailable.",
          );
        return body as {
          currency: string;
          items: {
            productId: string;
            estimatedAmountMinor: number;
            rate: { provider: string; sourceDate: string; fetchedAt: string };
          }[];
          note: string;
        };
      })
      .then((body) => {
        if (!active) return;
        setDisplayAmounts(
          Object.fromEntries(
            body.items.map((item) => [
              item.productId,
              item.estimatedAmountMinor,
            ]),
          ),
        );
        const sample = body.items[0]?.rate;
        setRateDescription(
          sample
            ? `${sample.provider === "MANUAL" ? "Store reference rate" : "Reference rate"} observed ${sample.sourceDate}; fetched ${new Date(sample.fetchedAt).toLocaleString()}.`
            : `Prices shown in the Store's listing currency (${body.currency}).`,
        );
      })
      .catch((reason) => {
        if (active) {
          setDisplayAmounts({});
          setCurrencyError(
            reason instanceof Error
              ? reason.message
              : "Display estimate unavailable.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [slug, store, displayCurrency]);

  useEffect(() => {
    const faviconId = store?.theme.faviconMediaId;
    let link = document.querySelector<HTMLLinkElement>(
      "link[data-store-branding-icon]",
    );
    if (typeof faviconId !== "string") {
      link?.remove();
      return undefined;
    }
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.dataset.storeBrandingIcon = "true";
      document.head.append(link);
    }
    link.type = "image/webp";
    link.href = `/content-media/${encodeURIComponent(faviconId)}`;
    return () => {
      document.querySelector("link[data-store-branding-icon]")?.remove();
    };
  }, [store?.theme.faviconMediaId]);

  if (error)
    return (
      <section className="page">
        <p className="eyebrow">Storefront</p>
        <h1>Store not found</h1>
        <p className="muted">
          This store is unavailable or its seller is not approved.
        </p>
      </section>
    );
  if (!store)
    return (
      <section className="page">
        <p className="eyebrow">Storefront</p>
        <h1>Loading store…</h1>
      </section>
    );
  const filteredProducts = store.products.filter(
    (product) =>
      (!selectedCategory || product.category?.slug === selectedCategory) &&
      `${product.name} ${product.description} ${product.category?.name ?? ""} ${product.brand?.name ?? ""} ${product.features?.map((feature) => feature.name).join(" ") ?? ""}`
        .toLocaleLowerCase()
        .includes(searchTerm.trim().toLocaleLowerCase()),
  );
  const visibleProducts = [...filteredProducts];
  if (productSort === "name")
    visibleProducts.sort((a, b) => a.name.localeCompare(b.name));
  if (productSort === "price-asc" || productSort === "price-desc") {
    const direction = productSort === "price-asc" ? 1 : -1;
    visibleProducts.sort((a, b) => {
      // Do not compare unlike currencies as though their minor units were
      // interchangeable. Currency is the primary key; amounts sort within it.
      const currencyOrder = a.currency.localeCompare(b.currency);
      if (currencyOrder) return currencyOrder;
      const aPrice =
        a.salePriceMinor != null && a.salePriceMinor < a.priceMinor
          ? a.salePriceMinor
          : a.priceMinor;
      const bPrice =
        b.salePriceMinor != null && b.salePriceMinor < b.priceMinor
          ? b.salePriceMinor
          : b.priceMinor;
      return (aPrice - bPrice) * direction;
    });
  }
  const configuredSections =
    store.theme.sections.length === 0
      ? [
          {
            type: "categories",
            title: "Shop by category",
            visible: true,
            categorySlug: null,
            productIds: [],
          },
        ]
      : store.theme.sections.filter((section) => section.visible);
  const featuredSales = store.products
    .filter(
      (product) =>
        product.salePriceMinor != null &&
        product.salePriceMinor < product.priceMinor,
    )
    .slice(0, 4);
  const tokens = store.designTokens ?? {
    surfaceColor: "#f4f6f1",
    cardColor: "#ffffff",
    textColor: "#17211b",
    mutedColor: "#536158",
    accentColor: "#315d47",
  };

  return (
    <section
      className="page storeFront"
      data-store-theme={store.theme.themePreset}
      data-mobile-template={store.theme.mobileTemplate}
      data-grid-density={store.theme.gridDensity}
      data-card-style={store.theme.cardStyle}
      style={{
        ["--store-font" as string]:
          store.theme.font === "serif"
            ? "Georgia, Times New Roman, serif"
            : store.theme.font === "rounded"
              ? "Trebuchet MS, Arial, sans-serif"
              : "system-ui, sans-serif",
        ["--store-primary" as string]: store.theme.primaryColor,
        ["--store-accent" as string]: store.theme.accentColor,
        ["--store-surface" as string]: tokens.surfaceColor,
        ["--store-card" as string]: tokens.cardColor,
        ["--store-ink" as string]: tokens.textColor,
        ["--store-muted" as string]: tokens.mutedColor,
        ["--store-theme-accent" as string]: tokens.accentColor,
      }}
    >
      <StoreSeoMetadata slug={slug} store={store} />
      <div className="storefrontIdentity">
        <a
          className="storefrontIdentityBrand"
          href={`/store/${encodeURIComponent(store.slug)}`}
          aria-label={`${store.name} Store homepage`}
        >
          {store.theme.logoMediaId && (
            <img
              className="storefrontLogo"
              src={`/content-media/${encodeURIComponent(store.theme.logoMediaId)}`}
              alt={`${store.name} logo`}
              loading="lazy"
              decoding="async"
            />
          )}
          <span>
            <small>Independent Store</small>
            <strong>{store.name}</strong>
          </span>
        </a>
        <a className="storefrontLiveLink" href="/live">
          Live shopping
        </a>
      </div>
      <StorefrontThemeIntro
        storeName={store.name}
        theme={store.theme}
        products={store.products}
      />
      <PublicCampaignPlacement
        placement="storefront"
        title={`Promotions at ${store.name}`}
      />
      <MarketplaceAdPlacementSection
        placement="STOREFRONTS"
        title={`Sponsored products at ${store.name}`}
      />
      <div className="storefrontConfiguredSections">
        {configuredSections.map((section, index) => {
          const pickedProducts = section.productIds.length
            ? store.products.filter((product) =>
                section.productIds.includes(product.id),
              )
            : [];
          const sectionProducts =
            section.type === "featuredProducts"
              ? (pickedProducts.length
                  ? pickedProducts
                  : filteredProducts
                ).slice(0, 4)
              : section.type === "productCollection"
                ? (pickedProducts.length
                    ? pickedProducts
                    : store.products.filter(
                        (product) =>
                          !section.categorySlug ||
                          product.category?.slug === section.categorySlug,
                      )
                  ).slice(0, 8)
                : [];
          if (section.type === "categories")
            return (
              <section
                className="storefrontConfiguredSection"
                key={`${section.type}-${index}`}
                aria-label={section.title}
              >
                <h2>{section.title || "Shop by category"}</h2>
                <StorefrontCategoryNav
                  products={store.products}
                  selectedCategory={selectedCategory}
                  onCategory={setSelectedCategory}
                />
              </section>
            );
          if (section.type === "brandHighlights") {
            const brands = [
              ...new Set(
                store.products
                  .map((product) => product.brand?.name)
                  .filter((name): name is string => Boolean(name)),
              ),
            ].slice(0, 8);
            const features = [
              ...new Set(
                store.products.flatMap(
                  (product) =>
                    product.features?.map((feature) => feature.name) ?? [],
                ),
              ),
            ].slice(0, 12);
            return (
              <section
                className="storefrontConfiguredSection"
                key={`${section.type}-${index}`}
                aria-label={section.title}
              >
                <h2>{section.title || "Brands and features"}</h2>
                {brands.length > 0 && (
                  <p className="storefrontThemeBrands">
                    Brands in this Store: {brands.join(" · ")}
                  </p>
                )}
                {features.length > 0 && (
                  <div className="storefrontTechFeatures">
                    {features.map((feature) => (
                      <span key={feature}>{feature}</span>
                    ))}
                  </div>
                )}
                {brands.length === 0 && features.length === 0 && (
                  <p className="muted">
                    Brand and feature details will appear when available in
                    approved listings.
                  </p>
                )}
              </section>
            );
          }
          const collection =
            section.type === "promotion" ? featuredSales : sectionProducts;
          if (section.type === "promotion" && collection.length === 0)
            return null;
          return (
            <section
              className={`storefrontConfiguredSection storefrontConfiguredSection--${section.type}`}
              key={`${section.type}-${index}`}
              aria-label={section.title}
            >
              <div className="sectionHeading">
                <h2>
                  {section.title ||
                    (section.type === "promotion"
                      ? "Current sale listings"
                      : section.type === "featuredProducts"
                        ? "Featured products"
                        : "Curated collection")}
                </h2>
                {section.type === "productCollection" &&
                  section.categorySlug && (
                    <span>
                      {
                        store.products.find(
                          (product) =>
                            product.category?.slug === section.categorySlug,
                        )?.category?.name
                      }
                    </span>
                  )}
              </div>
              <div className="storefrontMiniGrid">
                {collection.map((product) => {
                  const image =
                    product.images?.[0] ??
                    product.mediaAttachments?.find(
                      (media) => media.kind === "IMAGE",
                    );
                  const sale =
                    product.salePriceMinor != null &&
                    product.salePriceMinor < product.priceMinor;
                  return (
                    <article
                      className="storefrontMiniCard"
                      key={`${section.type}-${product.id}`}
                    >
                      {image && (
                        <a href={`/products/${product.id}`}>
                          <img
                            src={image.url}
                            alt={
                              "alt" in image
                                ? image.alt
                                : image.label || product.name
                            }
                            loading="lazy"
                            decoding="async"
                          />
                        </a>
                      )}
                      <a href={`/products/${product.id}`}>
                        <strong>{product.name}</strong>
                      </a>
                      <span>
                        {formatMinor(
                          sale ? product.salePriceMinor! : product.priceMinor,
                          product.currency,
                        )}
                      </span>
                      <small>
                        {product.availableStock > 0
                          ? `${product.availableStock} in stock`
                          : "Out of stock"}
                      </small>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className="sectionHeading">
        <h2>Products</h2>
        <label className="storefrontSearch">
          Search this Store
          <input
            aria-label="Search this Store's products"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Product name or category"
          />
        </label>
        {store.theme.themePreset === "ECOMMERCE_MARKETPLACE" && (
          <label>
            Sort products
            <select
              aria-label="Sort storefront products"
              value={productSort}
              onChange={(event) =>
                setProductSort(event.target.value as typeof productSort)
              }
            >
              <option value="featured">Featured order</option>
              <option value="name">Name A to Z</option>
              <option value="price-asc">
                Price low to high (within currency)
              </option>
              <option value="price-desc">
                Price high to low (within currency)
              </option>
            </select>
          </label>
        )}
        {currencies.length > 1 && (
          <label>
            Display currency
            <select
              aria-label="Store display currency"
              value={displayCurrency}
              onChange={(event) => setDisplayCurrency(event.target.value)}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} · {currency.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {displayCurrency !== store.products[0]?.currency && rateDescription && (
        <p className="muted">
          Estimated display prices · {rateDescription} These are not payment
          conversion rates.
        </p>
      )}
      {currencyError && (
        <p className="notice" role="status">
          {currencyError} Listing prices remain available in their original
          currency.
        </p>
      )}
      <StorefrontProductGrid
        products={visibleProducts}
        displayAmounts={displayAmounts}
        displayCurrency={displayCurrency}
        currencyError={currencyError}
      />
      {filteredProducts.length === 0 && (
        <div className="empty">
          {store.products.length
            ? "No products match your search."
            : "This store has no approved products available."}
        </div>
      )}
      <JimaRecommendations placement="store" />
      {newsletter?.available && (
        <section className="card cardBody storeNewsletter">
          <p className="eyebrow">From {store.name}</p>
          <h2>Get store updates</h2>
          <p className="muted">
            Optional email updates from this Store. Confirm your address before
            any marketing email is sent; unsubscribe at any time.
          </p>
          <form onSubmit={subscribe}>
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                value={newsletterEmail}
                onChange={(event) => setNewsletterEmail(event.target.value)}
              />
            </label>
            <label className="storePlanCheck">
              <input
                type="checkbox"
                required
                checked={newsletterConsent}
                onChange={(event) => setNewsletterConsent(event.target.checked)}
              />
              I agree to receive optional email updates from {store.name}. I can
              unsubscribe at any time.
            </label>
            <button
              className="primary"
              disabled={newsletterBusy || !newsletterConsent}
            >
              {newsletterBusy ? "Submitting…" : "Send confirmation email"}
            </button>
          </form>
          {newsletterError && (
            <p className="notice" role="alert">
              {newsletterError}
            </p>
          )}
          {newsletterMessage && (
            <p className="notice" role="status">
              {newsletterMessage}
            </p>
          )}
        </section>
      )}
      <StoreContentLinks slug={store.slug} content={store.content} />
    </section>
  );
}
