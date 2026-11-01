import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrandingImageControl } from "./BrandingImageControl.js";
import { formatMinor } from "./money.js";

type ThemePreset =
  | "CLASSIC"
  | "EDITORIAL"
  | "BOUTIQUE"
  | "TECH_ELECTRONICS"
  | "GROCERIES"
  | "ECOMMERCE_MARKETPLACE";
type SectionType =
  | "featuredProducts"
  | "categories"
  | "promotion"
  | "productCollection"
  | "brandHighlights";
type Theme = {
  themePreset: ThemePreset;
  mobileTemplate: string;
  description: string;
  heroTitle: string;
  heroSubtitle: string;
  heroButtonLabel: string;
  heroButtonHref: string;
  primaryColor: string;
  accentColor: string;
  font: string;
  gridDensity: "comfortable" | "standard" | "dense";
  cardStyle: "standard" | "editorial" | "soft" | "technical";
  sections: {
    type: SectionType;
    title: string;
    productIds: string[];
    categorySlug: string | null;
    visible: boolean;
  }[];
  contactLinks: { label: string; url: string }[];
  logoMediaId: string | null;
  faviconMediaId: string | null;
  bannerMediaId: string | null;
};
type CatalogTheme = {
  id: ThemePreset;
  name: string;
  tier: "FREE" | "PAID";
  description: string;
  features: readonly string[];
  defaultTokens: {
    surfaceColor: string;
    cardColor: string;
    textColor: string;
    mutedColor: string;
    accentColor: string;
  };
};
type Revision = {
  id: string;
  version: number;
  themeJson: Theme;
  changeNote: string | null;
  createdAt: string;
  editor: { name: string | null; email: string };
};
type ThemeProductOption = {
  id: string;
  name: string;
  category: { name: string; slug: string } | null;
};
type ThemePreviewProduct = ThemeProductOption & {
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  availableStock: number;
  images: { url: string; alt: string }[];
};
const emptyTheme: Theme = {
  themePreset: "CLASSIC",
  mobileTemplate: "RESPONSIVE_STANDARD",
  description: "",
  heroTitle: "",
  heroSubtitle: "",
  heroButtonLabel: "",
  heroButtonHref: "",
  primaryColor: "#1f6f5b",
  accentColor: "#e7b75a",
  font: "system",
  gridDensity: "standard",
  cardStyle: "standard",
  sections: [],
  contactLinks: [],
  logoMediaId: null,
  faviconMediaId: null,
  bannerMediaId: null,
};
const sectionOptions: { type: SectionType; title: string }[] = [
  { type: "featuredProducts", title: "Featured products" },
  { type: "categories", title: "Category highlights" },
  { type: "productCollection", title: "Curated collection" },
  { type: "promotion", title: "Promotional content" },
  { type: "brandHighlights", title: "Brand and feature highlights" },
];

function colorContrast(first: string, second: string) {
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

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function normalized(value: Partial<Theme>): Theme {
  return {
    ...emptyTheme,
    ...value,
    sections: (value.sections ?? []).map((section) => ({
      ...section,
      categorySlug: section.categorySlug ?? null,
      visible: section.visible ?? true,
    })),
  };
}

function ThemeArtwork({ theme }: { theme: ThemePreset }) {
  return (
    <div className="themeArtwork" data-theme={theme} aria-hidden="true">
      <div className="themeArtworkTop">
        <span />
        <i />
        <i />
        <i />
      </div>
      <div className="themeArtworkBody">
        <div className="themeArtworkHero">
          <span />
          <b />
          <b />
          <small />
        </div>
        <div className="themeArtworkCards">
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

function ThemePreview({
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

export function StoreThemeStudio() {
  const [catalog, setCatalog] = useState<CatalogTheme[]>([]);
  const [theme, setTheme] = useState<Theme>(emptyTheme);
  const [published, setPublished] = useState<Theme | null>(null);
  const [allowedThemes, setAllowedThemes] = useState<ThemePreset[]>([
    "CLASSIC",
    "EDITORIAL",
    "BOUTIQUE",
  ]);
  const [storeName, setStoreName] = useState("");
  const [slug, setSlug] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [availableProducts, setAvailableProducts] = useState<
    ThemeProductOption[]
  >([]);
  const [previewProducts, setPreviewProducts] = useState<ThemePreviewProduct[]>(
    [],
  );
  const [previewPreset, setPreviewPreset] = useState<ThemePreset>("CLASSIC");
  const [device, setDevice] = useState("desktop");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const initialTheme = useRef("");
  const dirty = useMemo(
    () => JSON.stringify(theme) !== initialTheme.current,
    [theme],
  );

  const load = async () => {
    const [catalogResponse, current, history] = await Promise.all([
      api<{ themes: CatalogTheme[] }>("/api/store-themes/catalog"),
      api<{
        name: string;
        slug: string;
        draft: Theme;
        published: Theme | null;
        draftVersion: number;
        themeAccess: { allowedThemes: ThemePreset[] };
        availableProducts: ThemeProductOption[];
      }>("/api/seller/store-theme"),
      api<{ revisions: Revision[] }>("/api/seller/store-theme/revisions"),
    ]);
    const nextTheme = normalized(current.draft);
    setCatalog(catalogResponse.themes);
    setTheme(nextTheme);
    setPublished(current.published ? normalized(current.published) : null);
    setAllowedThemes(current.themeAccess.allowedThemes);
    setStoreName(current.name);
    setSlug(current.slug);
    setDraftVersion(current.draftVersion);
    setRevisions(history.revisions);
    setAvailableProducts(current.availableProducts);
    const publicPreview = await api<{ products?: ThemePreviewProduct[] }>(
      `/api/stores/${encodeURIComponent(current.slug)}`,
    ).catch(() => null);
    setPreviewProducts(publicPreview?.products ?? []);
    setPreviewPreset(nextTheme.themePreset);
    initialTheme.current = JSON.stringify(nextTheme);
  };

  useEffect(() => {
    let active = true;
    void load()
      .catch((error) => {
        if (active) setMessage((error as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (publish = false) => {
    setBusy(true);
    setMessage(
      publish ? "Saving and publishing your theme…" : "Saving your draft…",
    );
    try {
      const saved = await api<{ draftVersion: number }>(
        "/api/seller/store-theme",
        {
          method: "PUT",
          body: JSON.stringify({
            ...theme,
            name: storeName,
            expectedVersion: draftVersion,
            changeNote: publish
              ? "Published from Themes Studio"
              : "Saved from Themes Studio",
          }),
        },
      );
      const nextVersion = saved.draftVersion;
      if (publish)
        await api("/api/seller/store-theme/publish", {
          method: "POST",
          body: JSON.stringify({ expectedVersion: nextVersion }),
        });
      await load();
      setMessage(
        publish
          ? `Theme published for ${storeName}.`
          : "Draft saved. Public visitors still see the last published version.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (revision: Revision) => {
    if (
      !window.confirm(
        `Restore revision ${revision.version} as a new draft? It will not be published automatically.`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api<{ draftVersion: number }>(
        `/api/seller/store-theme/revisions/${encodeURIComponent(revision.id)}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: draftVersion }),
        },
      );
      await load();
      setDraftVersion(result.draftVersion);
      setMessage(
        `Revision ${revision.version} restored as a draft. Review and publish it when ready.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setSection = (type: SectionType, visible: boolean) =>
    setTheme((current) => {
      const existing = current.sections.find(
        (section) => section.type === type,
      );
      const next = existing
        ? current.sections.map((section) =>
            section.type === type ? { ...section, visible } : section,
          )
        : [
            ...current.sections,
            {
              type,
              title:
                sectionOptions.find((item) => item.type === type)?.title ??
                type,
              productIds: [],
              categorySlug: null,
              visible,
            },
          ];
      return { ...current, sections: next };
    });
  const updateSection = (
    type: SectionType,
    values: Partial<Theme["sections"][number]>,
  ) =>
    setTheme((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.type === type ? { ...section, ...values } : section,
      ),
    }));
  const moveSection = (index: number, delta: number) =>
    setTheme((current) => {
      const sections = [...current.sections];
      const target = index + delta;
      if (target < 0 || target >= sections.length) return current;
      [sections[index], sections[target]] = [
        sections[target]!,
        sections[index]!,
      ];
      return { ...current, sections };
    });

  if (loading)
    return (
      <section className="page">
        <h1>Themes &amp; Templates Studio</h1>
        <p className="empty" role="status">
          Loading your Store theme and plan eligibility…
        </p>
      </section>
    );
  const permitted = allowedThemes.includes(theme.themePreset);
  const activeTokens = catalog.find(
    (item) => item.id === theme.themePreset,
  )?.defaultTokens;
  const colorWarnings = activeTokens
    ? [
        ...((
          theme.themePreset === "TECH_ELECTRONICS"
            ? colorContrast("#ffffff", theme.primaryColor) < 4.5
            : colorContrast(theme.primaryColor, activeTokens.cardColor) < 4.5 ||
              colorContrast(theme.primaryColor, activeTokens.surfaceColor) <
                4.5 ||
              colorContrast("#ffffff", theme.primaryColor) < 4.5
        )
          ? ["Primary brand color"]
          : []),
        ...(colorContrast(theme.accentColor, activeTokens.cardColor) < 4.5 ||
        colorContrast(theme.accentColor, activeTokens.surfaceColor) < 4.5
          ? ["Accent color"]
          : []),
      ]
    : [];
  return (
    <section className="page storeThemeStudio">
      <header className="themeStudioHeading">
        <div>
          <p className="eyebrow">Seller workspace · {storeName || "Store"}</p>
          <h1>Themes &amp; Templates Studio</h1>
          <p className="muted">
            Explore every layout, customize your Store and preview privately
            before publishing. Your existing products, cart, checkout and Store
            header/footer are preserved.
          </p>
        </div>
        <a
          className="button"
          href={
            slug ? `/store/${encodeURIComponent(slug)}` : "/seller/platform"
          }
        >
          View published Store
        </a>
      </header>
      {message && (
        <p className="notice" role="status" aria-live="polite">
          {message}
        </p>
      )}
      {published?.themePreset &&
        !allowedThemes.includes(published.themePreset as ThemePreset) && (
          <p className="notice">
            Your saved paid theme is retained but temporarily not shown
            publicly. The Store displays Classic until the required paid
            subscription is active again.
          </p>
        )}
      <section
        className="themeStudioGallery"
        aria-labelledby="theme-gallery-title"
      >
        <div className="themeStudioSectionHeading">
          <div>
            <p className="eyebrow">Six responsive templates</p>
            <h2 id="theme-gallery-title">Choose a storefront direction</h2>
          </div>
          <span>{allowedThemes.length} available to publish</span>
        </div>
        <div className="themeGalleryGrid">
          {catalog.map((item) => {
            const unlocked = allowedThemes.includes(item.id);
            return (
              <article
                className={`themeGalleryCard ${previewPreset === item.id ? "is-previewing" : ""}`}
                key={item.id}
              >
                <ThemeArtwork theme={item.id} />
                <div className="themeGalleryCardBody">
                  <div className="themeGalleryCardTitle">
                    <h3>{item.name}</h3>
                    <span
                      className={
                        item.tier === "PAID"
                          ? "themeTier themeTier--paid"
                          : "themeTier"
                      }
                    >
                      {item.tier === "FREE" ? "Free" : "Paid"}
                    </span>
                  </div>
                  <p>{item.description}</p>
                  <ul>
                    {item.features.map((feature) => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                  <div className="toolbar">
                    <button
                      type="button"
                      onClick={() => setPreviewPreset(item.id)}
                    >
                      {previewPreset === item.id ? "Previewing" : "Preview"}
                    </button>
                    {unlocked ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => {
                          setTheme((current) => ({
                            ...current,
                            themePreset: item.id,
                          }));
                          setPreviewPreset(item.id);
                        }}
                      >
                        Use theme
                      </button>
                    ) : (
                      <a className="button" href="/seller/plan">
                        Upgrade to unlock
                      </a>
                    )}
                  </div>
                  {!unlocked && (
                    <small className="muted">
                      Preview is available; saving or publishing requires an
                      eligible active paid subscription.
                    </small>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <div className="themeStudioWorkspace">
        <section className="themeStudioEditor card cardBody">
          <p className="eyebrow">
            Private editor · {dirty ? "Unsaved changes" : "Saved draft"}
          </p>
          <h2>
            Customize{" "}
            {catalog.find((item) => item.id === theme.themePreset)?.name ??
              "your theme"}
          </h2>
          <p className="muted">
            Changes below affect the private preview until you save; public
            pages continue using the last published version.
          </p>
          {!permitted && (
            <p className="notice">
              This saved theme is currently locked by plan eligibility. Select
              one of the free themes to save or publish while on the current
              plan.
            </p>
          )}
          <label>
            Brand description
            <textarea
              maxLength={1000}
              value={theme.description}
              onChange={(event) =>
                setTheme({ ...theme, description: event.target.value })
              }
            />
          </label>
          <label>
            Hero headline
            <input
              maxLength={120}
              value={theme.heroTitle}
              onChange={(event) =>
                setTheme({ ...theme, heroTitle: event.target.value })
              }
            />
          </label>
          <label>
            Hero description
            <textarea
              maxLength={400}
              value={theme.heroSubtitle}
              onChange={(event) =>
                setTheme({ ...theme, heroSubtitle: event.target.value })
              }
            />
          </label>
          <div className="themeTokenInputs">
            <label>
              Primary brand color
              <input
                type="color"
                value={theme.primaryColor}
                onChange={(event) =>
                  setTheme({ ...theme, primaryColor: event.target.value })
                }
              />
            </label>
            <label>
              Accent color
              <input
                type="color"
                value={theme.accentColor}
                onChange={(event) =>
                  setTheme({ ...theme, accentColor: event.target.value })
                }
              />
            </label>
            <label>
              Typography
              <select
                value={theme.font}
                onChange={(event) =>
                  setTheme({ ...theme, font: event.target.value })
                }
              >
                <option value="system">System sans</option>
                <option value="serif">Editorial serif</option>
                <option value="rounded">Rounded</option>
              </select>
            </label>
            <label>
              Product density
              <select
                value={theme.gridDensity}
                onChange={(event) =>
                  setTheme({
                    ...theme,
                    gridDensity: event.target.value as Theme["gridDensity"],
                  })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="standard">Standard</option>
                <option value="dense">Dense</option>
              </select>
            </label>
          </div>
          {colorWarnings.length > 0 && (
            <p className="storeThemeContrastWarning" role="status">
              Contrast advisory: {colorWarnings.join(" and ")} may not meet the
              4.5:1 WCAG AA normal-text target in this theme. Choose a stronger
              color or use it only as a decorative accent; the preview remains
              available for review.
            </p>
          )}
          <label>
            Hero button label
            <input
              maxLength={60}
              value={theme.heroButtonLabel}
              onChange={(event) =>
                setTheme({ ...theme, heroButtonLabel: event.target.value })
              }
            />
          </label>
          <label>
            Hero button destination (same-site path)
            <input
              maxLength={500}
              placeholder="/shop"
              value={theme.heroButtonHref}
              onChange={(event) =>
                setTheme({ ...theme, heroButtonHref: event.target.value })
              }
            />
          </label>
          <BrandingImageControl
            label="Store logo"
            ratio={3}
            value={theme.logoMediaId}
            publishedValue={published?.logoMediaId}
            onChange={(logoMediaId) =>
              setTheme((current) => ({ ...current, logoMediaId }))
            }
            listUrl="/api/seller/store-media"
            uploadUrl="/api/seller/store-media/uploads"
            previewUrl={(id) =>
              `/api/seller/store-media/${encodeURIComponent(id)}/preview`
            }
            quota
          />
          <BrandingImageControl
            label="Store favicon"
            ratio={1}
            value={theme.faviconMediaId}
            publishedValue={published?.faviconMediaId}
            onChange={(faviconMediaId) =>
              setTheme((current) => ({ ...current, faviconMediaId }))
            }
            listUrl="/api/seller/store-media"
            uploadUrl="/api/seller/store-media/uploads"
            previewUrl={(id) =>
              `/api/seller/store-media/${encodeURIComponent(id)}/preview`
            }
            quota
          />
          <BrandingImageControl
            label="Store hero / banner image"
            ratio={2.4}
            value={theme.bannerMediaId}
            publishedValue={published?.bannerMediaId}
            onChange={(bannerMediaId) =>
              setTheme((current) => ({ ...current, bannerMediaId }))
            }
            listUrl="/api/seller/store-media"
            uploadUrl="/api/seller/store-media/uploads"
            previewUrl={(id) =>
              `/api/seller/store-media/${encodeURIComponent(id)}/preview`
            }
            quota
          />
          <fieldset className="themeSectionsEditor">
            <legend>Sections · visibility, content and ordering</legend>
            {sectionOptions.map((option) => {
              const index = theme.sections.findIndex(
                (section) => section.type === option.type,
              );
              const section = index >= 0 ? theme.sections[index] : null;
              const categories = [
                ...new Map(
                  availableProducts.flatMap((product) =>
                    product.category
                      ? [
                          [
                            product.category.slug,
                            product.category.name,
                          ] as const,
                        ]
                      : [],
                  ),
                ).entries(),
              ];
              return (
                <div className="themeSectionEditor" key={option.type}>
                  <div className="themeSectionRow">
                    <label>
                      <input
                        type="checkbox"
                        checked={section?.visible ?? false}
                        onChange={(event) =>
                          setSection(option.type, event.target.checked)
                        }
                      />
                      {option.title}
                    </label>
                    {section && (
                      <div>
                        <button
                          type="button"
                          aria-label={`Move ${option.title} up`}
                          disabled={index === 0}
                          onClick={() => moveSection(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${option.title} down`}
                          disabled={index === theme.sections.length - 1}
                          onClick={() => moveSection(index, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    )}
                  </div>
                  {section?.visible && (
                    <div className="themeSectionOptions">
                      <label>
                        Section heading
                        <input
                          maxLength={120}
                          value={section.title}
                          onChange={(event) =>
                            updateSection(option.type, {
                              title: event.target.value,
                            })
                          }
                        />
                      </label>
                      {(option.type === "featuredProducts" ||
                        option.type === "productCollection") && (
                        <label>
                          Approved products (optional; choose up to 50)
                          <select
                            multiple
                            size={Math.min(
                              6,
                              Math.max(3, availableProducts.length),
                            )}
                            value={section.productIds}
                            onChange={(event) =>
                              updateSection(option.type, {
                                productIds: Array.from(
                                  event.currentTarget.selectedOptions,
                                )
                                  .slice(0, 50)
                                  .map((selected) => selected.value),
                              })
                            }
                          >
                            {availableProducts.map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.name}
                                {product.category
                                  ? ` · ${product.category.name}`
                                  : ""}
                              </option>
                            ))}
                          </select>
                          <small className="muted">
                            No selection uses current approved listings. Removed
                            or unapproved listings are never displayed.
                          </small>
                        </label>
                      )}
                      {option.type === "productCollection" && (
                        <label>
                          Limit collection to category
                          <select
                            value={section.categorySlug ?? ""}
                            onChange={(event) =>
                              updateSection(option.type, {
                                categorySlug: event.target.value || null,
                              })
                            }
                          >
                            <option value="">All categories</option>
                            {categories.map(([categorySlug, name]) => (
                              <option key={categorySlug} value={categorySlug}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
          <label>
            Mobile layout
            <select
              value={theme.mobileTemplate}
              onChange={(event) =>
                setTheme({ ...theme, mobileTemplate: event.target.value })
              }
            >
              <option value="RESPONSIVE_STANDARD">Responsive standard</option>
              <option value="MOBILE_COMPACT">Compact</option>
              <option value="MOBILE_EDITORIAL">Editorial</option>
            </select>
          </label>
          <div className="themeStudioSaveBar">
            <span>
              {published
                ? `Published ${catalog.find((item) => item.id === published.themePreset)?.name ?? published.themePreset}`
                : "No custom theme has been published yet"}
            </span>
            <button type="button" onClick={() => void load()} disabled={busy}>
              Discard / reload
            </button>
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={busy || !permitted}
            >
              {busy ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void save(true)}
              disabled={busy || !permitted}
            >
              {busy ? "Saving…" : "Publish changes"}
            </button>
          </div>
        </section>
        <section className="themeStudioPreviewPanel">
          <div className="themeStudioPreviewHead">
            <div>
              <p className="eyebrow">Live private preview · approved catalog</p>
              <h2>
                {catalog.find((item) => item.id === previewPreset)?.name ??
                  previewPreset}
              </h2>
            </div>
            <div
              role="group"
              aria-label="Preview viewport"
              className="themeDeviceControls"
            >
              {["desktop", "tablet", "mobile"].map((option) => (
                <button
                  type="button"
                  key={option}
                  aria-pressed={device === option}
                  className={device === option ? "active" : ""}
                  onClick={() => setDevice(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <ThemePreview
            preset={previewPreset}
            theme={theme}
            catalog={catalog}
            storeName={storeName}
            device={device}
            products={previewProducts}
          />
          <p className="muted">
            This private preview uses your Store's approved catalog data only.
            Product prices and availability are current listing values; cart,
            checkout and promotional placements remain unchanged.
          </p>
          <section className="themeRevisionList">
            <h3>Theme history</h3>
            {revisions.length ? (
              revisions.map((revision) => (
                <article key={revision.id}>
                  <div>
                    <strong>Version {revision.version}</strong>
                    <small>
                      {new Date(revision.createdAt).toLocaleString()} ·{" "}
                      {revision.editor.name || revision.editor.email}
                    </small>
                    {revision.changeNote && (
                      <small>{revision.changeNote}</small>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !allowedThemes.includes(revision.themeJson.themePreset)
                    }
                    onClick={() => void restore(revision)}
                  >
                    Restore as draft
                  </button>
                </article>
              ))
            ) : (
              <p className="empty">Saved theme revisions will appear here.</p>
            )}
          </section>
          <nav
            className="themeStudioLinks"
            aria-label="Other Store appearance controls"
          >
            <a href="/seller/platform">Store settings</a>
            <a href="/seller/site-chrome">Store header &amp; footer</a>
            <a href="/seller/plan">Plan and usage</a>
          </nav>
        </section>
      </div>
    </section>
  );
}
