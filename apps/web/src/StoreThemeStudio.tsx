import { useEffect, useMemo, useRef, useState } from "react";
import { BrandingImageControl } from "./BrandingImageControl.js";
import { StoreThemeSectionsEditor } from "./StoreThemeSectionsEditor.js";
import {
  StoreThemeArtwork,
  StoreThemePreview,
  themeContrastRatio,
} from "./store-theme-presentation.js";
import type {
  CatalogTheme,
  Revision,
  Theme,
  ThemePreviewProduct,
  ThemeProductOption,
  ThemePreset,
} from "./store-theme-types.js";
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
    let active = true;
    const refreshThemePreviewImages = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await api<{ themes: CatalogTheme[] }>(
          "/api/store-themes/catalog",
        );
        if (active) setCatalog(result.themes);
      } catch {
        // Keep the last published theme preview available during a transient network failure.
      }
    };
    const timer = window.setInterval(
      () => void refreshThemePreviewImages(),
      15_000,
    );
    document.addEventListener("visibilitychange", refreshThemePreviewImages);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener(
        "visibilitychange",
        refreshThemePreviewImages,
      );
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
            ? themeContrastRatio("#ffffff", theme.primaryColor) < 4.5
            : themeContrastRatio(theme.primaryColor, activeTokens.cardColor) <
                4.5 ||
              themeContrastRatio(
                theme.primaryColor,
                activeTokens.surfaceColor,
              ) < 4.5 ||
              themeContrastRatio("#ffffff", theme.primaryColor) < 4.5
        )
          ? ["Primary brand color"]
          : []),
        ...(themeContrastRatio(theme.accentColor, activeTokens.cardColor) <
          4.5 ||
        themeContrastRatio(theme.accentColor, activeTokens.surfaceColor) < 4.5
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
                <StoreThemeArtwork
                  preset={item.id}
                  name={item.name}
                  src={item.previewImageUrl}
                />
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
          <StoreThemeSectionsEditor
            theme={theme}
            setTheme={setTheme}
            availableProducts={availableProducts}
          />
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
          <StoreThemePreview
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
