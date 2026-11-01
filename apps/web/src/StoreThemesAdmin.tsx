import React, { useEffect, useState } from "react";

type Preset =
  | "CLASSIC"
  | "EDITORIAL"
  | "BOUTIQUE"
  | "TECH_ELECTRONICS"
  | "GROCERIES"
  | "ECOMMERCE_MARKETPLACE";
type Tokens = {
  surfaceColor: string;
  cardColor: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
};
type ThemeInfo = {
  id: Preset;
  name: string;
  tier: "FREE" | "PAID";
  description: string;
  features: string[];
  defaultTokens: Tokens;
};
type Config = {
  displayOrder: Preset[];
  visibleThemes: Preset[];
  tokens: Record<Preset, Tokens>;
};
type Store = {
  id: string;
  name: string;
  slug: string;
  isPlatformStore: boolean;
  themePreset: string | null;
  publishedAt: string | null;
};
type Audit = {
  id: string;
  createdAt: string;
  metadata: { reason?: string; config?: Config } | null;
  actor: { name: string | null; email: string } | null;
};
type AdminData = {
  themes: ThemeInfo[];
  config: Config;
  configUpdatedAt: string | null;
  usage: Record<Preset, number>;
  stores: Store[];
  history: Audit[];
};
type PreviewStore = {
  name: string;
  products: {
    id: string;
    name: string;
    priceMinor: number;
    salePriceMinor: number | null;
    currency: string;
    availableStock: number;
    images: { url: string; alt: string }[];
    category: { name: string; slug: string } | null;
  }[];
};

function contrastRatio(first: string, second: string) {
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

function ThemeArtwork({ preset }: { preset: Preset }) {
  return (
    <div className="themeArtwork" data-theme={preset} aria-hidden="true">
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

export function StoreThemesAdmin() {
  const [data, setData] = useState<AdminData | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(
    null,
  );
  const [reason, setReason] = useState(
    "Reviewed storefront theme catalog defaults",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewPreset, setPreviewPreset] = useState<Preset>("CLASSIC");
  const [previewSlug, setPreviewSlug] = useState("");
  const [previewDevice, setPreviewDevice] = useState<
    "desktop" | "tablet" | "mobile"
  >("desktop");
  const [previewStore, setPreviewStore] = useState<PreviewStore | null>(null);

  const load = async () => {
    const result = await api<AdminData>("/api/admin/store-themes");
    setData(result);
    setConfig(result.config);
    setExpectedUpdatedAt(result.configUpdatedAt);
  };
  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
  }, []);
  useEffect(() => {
    if (!previewSlug) {
      setPreviewStore(null);
      return undefined;
    }
    let active = true;
    fetch(`/api/stores/${encodeURIComponent(previewSlug)}`, {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) =>
        response.ok ? (response.json() as Promise<PreviewStore>) : null,
      )
      .then((result) => {
        if (active) setPreviewStore(result);
      })
      .catch(() => {
        if (active) setPreviewStore(null);
      });
    return () => {
      active = false;
    };
  }, [previewSlug]);

  const save = async () => {
    if (!config) return;
    setBusy(true);
    setMessage("Saving the platform theme catalog…");
    try {
      await api("/api/admin/store-themes/catalog", {
        method: "PUT",
        body: JSON.stringify({ config, expectedUpdatedAt, reason }),
      });
      await load();
      setMessage(
        "Theme catalog defaults and order saved. Existing seller brand colors and published configurations remain intact.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) =>
    setConfig((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.displayOrder.length) return current;
      const displayOrder = [...current.displayOrder];
      [displayOrder[index], displayOrder[target]] = [
        displayOrder[target]!,
        displayOrder[index]!,
      ];
      return { ...current, displayOrder };
    });

  if (!data || !config)
    return (
      <section className="storeThemesAdmin">
        <h2>Theme management</h2>
        <p className="empty" role="status">
          Loading theme catalog and Store usage…
        </p>
        {message && <p className="notice">{message}</p>}
      </section>
    );
  const themesById = new Map(data.themes.map((theme) => [theme.id, theme]));
  const previewTheme = themesById.get(previewPreset);
  const previewTokens = config.tokens[previewPreset];
  const categories = [
    ...new Map(
      (previewStore?.products ?? []).flatMap((product) =>
        product.category
          ? [[product.category.slug, product.category.name] as const]
          : [],
      ),
    ).values(),
  ].slice(0, 6);
  return (
    <section className="storeThemesAdmin">
      <header className="themeStudioHeading">
        <div>
          <p className="eyebrow">Platform settings</p>
          <h2>Themes &amp; Templates Management</h2>
          <p className="muted">
            Manage the six code-owned storefront implementations, marketplace
            availability, display order and contrast-checked design defaults.
            Classic always remains available as the safe fallback.
          </p>
        </div>
        <a href="/admin/platform?section=chrome">
          Open Header &amp; Footer Builder
        </a>
      </header>
      {message && (
        <p className="notice" role="status" aria-live="polite">
          {message}
        </p>
      )}
      <div className="themeAdminGrid">
        {config.displayOrder.map((preset, index) => {
          const item = themesById.get(preset);
          if (!item) return null;
          const tokens = config.tokens[preset];
          const lowAccentContrast =
            contrastRatio(tokens.accentColor, tokens.cardColor) < 4.5 ||
            contrastRatio(tokens.accentColor, tokens.surfaceColor) < 4.5;
          return (
            <article className="themeAdminCard" key={preset}>
              <ThemeArtwork preset={preset} />
              <div className="themeAdminCardBody">
                <header>
                  <div>
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
                  <strong>{data.usage[preset] ?? 0} saved uses</strong>
                </header>
                <label className="themeAvailabilityToggle">
                  <input
                    type="checkbox"
                    aria-label={`Make ${item.name} available to eligible Stores`}
                    checked={config.visibleThemes.includes(preset)}
                    disabled={busy || preset === "CLASSIC"}
                    onChange={(event) =>
                      setConfig((current) => {
                        if (!current || preset === "CLASSIC") return current;
                        const visibleThemes = event.target.checked
                          ? [...current.visibleThemes, preset]
                          : current.visibleThemes.filter(
                              (theme) => theme !== preset,
                            );
                        return { ...current, visibleThemes };
                      })
                    }
                  />
                  {preset === "CLASSIC"
                    ? "Always available · safe fallback"
                    : config.visibleThemes.includes(preset)
                      ? "Available to eligible Stores"
                      : "Hidden from new selections"}
                </label>
                <p>{item.description}</p>
                <ol>
                  {item.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ol>
                <fieldset className="themeAdminTokens">
                  <legend>Default presentation tokens</legend>
                  {(Object.keys(tokens) as (keyof Tokens)[]).map((key) => (
                    <label key={key}>
                      {key.replace("Color", "").replace(/([A-Z])/g, " $1")}
                      <input
                        type="color"
                        aria-label={`${item.name} default ${key}`}
                        value={tokens[key]}
                        onChange={(event) =>
                          setConfig((current) =>
                            current
                              ? {
                                  ...current,
                                  tokens: {
                                    ...current.tokens,
                                    [preset]: {
                                      ...current.tokens[preset],
                                      [key]: event.target.value,
                                    },
                                  },
                                }
                              : current,
                          )
                        }
                      />
                    </label>
                  ))}
                </fieldset>
                {lowAccentContrast && (
                  <p className="storeThemeContrastWarning" role="status">
                    Accent contrast is below 4.5:1 on this theme's surface or
                    cards. Use an accessible link/accent color before publishing
                    defaults.
                  </p>
                )}
                <div className="themeOrderControls">
                  <span>Catalog position {index + 1}</span>
                  <button
                    type="button"
                    onClick={() => setPreviewPreset(preset)}
                  >
                    Preview this theme
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${item.name} up`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${item.name} down`}
                    disabled={busy || index === config.displayOrder.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Move down
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <section className="card cardBody themeAdminPreview">
        <header className="themeStudioPreviewHead">
          <div>
            <p className="eyebrow">Authorized public-catalog preview</p>
            <h3>{previewTheme?.name ?? previewPreset}</h3>
          </div>
          <div
            role="group"
            aria-label="Administrator preview viewport"
            className="themeDeviceControls"
          >
            {(["desktop", "tablet", "mobile"] as const).map((device) => (
              <button
                key={device}
                type="button"
                aria-pressed={previewDevice === device}
                className={previewDevice === device ? "active" : ""}
                onClick={() => setPreviewDevice(device)}
              >
                {device}
              </button>
            ))}
          </div>
        </header>
        <label>
          Approved Store
          <select
            value={previewSlug}
            onChange={(event) => setPreviewSlug(event.target.value)}
          >
            <option value="">Choose an approved Store</option>
            {data.stores.map((store) => (
              <option key={store.id} value={store.slug}>
                {store.name}
                {store.isPlatformStore ? " · Official platform Store" : ""}
              </option>
            ))}
          </select>
        </label>
        <div
          className={`themePreviewFrame themePreviewFrame--${previewDevice}`}
          data-theme={previewPreset}
          style={
            {
              "--preview-surface": previewTokens.surfaceColor,
              "--preview-card": previewTokens.cardColor,
              "--preview-ink": previewTokens.textColor,
              "--preview-muted": previewTokens.mutedColor,
              "--preview-accent": previewTokens.accentColor,
              "--preview-primary": previewTokens.accentColor,
            } as React.CSSProperties
          }
        >
          <div className="themePreviewTop">
            <strong>{previewStore?.name ?? "Store preview"}</strong>
            <span>Approved catalog</span>
            <small>Cart</small>
          </div>
          <div className="themePreviewHero">
            <small>PRIVATE ADMIN PREVIEW</small>
            <h3>{previewTheme?.name}</h3>
            <p>{previewTheme?.description}</p>
          </div>
          {categories.length > 0 && (
            <div className="themePreviewCategories">
              {categories.map(([slug, name]) => (
                <span key={slug}>{name}</span>
              ))}
            </div>
          )}
          {previewStore?.products.length ? (
            <div className="themePreviewProducts">
              {previewStore.products.slice(0, 4).map((product) => (
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
                    {product.availableStock > 0
                      ? `${product.availableStock} in stock`
                      : "Out of stock"}{" "}
                    · {product.currency}
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="themePreviewEmpty">
              Choose a Store with approved listings to view its real product
              catalog. No private draft or unapproved products are loaded here.
            </p>
          )}
        </div>
      </section>
      <section className="card cardBody themeAdminSave">
        <h3>Publish safe catalog defaults</h3>
        <p className="muted">
          Text contrast is validated at 4.5:1 against card and surface colors.
          The three paid templates remain inaccessible to free or legacy sellers
          regardless of catalog order.
        </p>
        <label>
          Audit reason
          <input
            value={reason}
            maxLength={500}
            minLength={5}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button
          className="primary"
          type="button"
          disabled={busy || reason.trim().length < 5}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save catalog configuration"}
        </button>
      </section>
      <section className="themeAdminUsage">
        <h3>Published theme assignments</h3>
        <p className="muted">
          Counts show saved published presets; an inactive premium subscription
          is still rendered publicly with the free Classic fallback and is not
          deleted.
        </p>
        {data.stores.length ? (
          <div className="table">
            {data.stores.map((store) => (
              <div className="row" key={store.id}>
                <strong>
                  {store.name}
                  {store.isPlatformStore ? " · Official platform Store" : ""}
                </strong>
                <span>
                  {store.themePreset
                    ? String(store.themePreset).replaceAll("_", " ")
                    : "Default Classic"}
                </span>
                <span>
                  {store.publishedAt
                    ? new Date(store.publishedAt).toLocaleDateString()
                    : "Not published"}
                </span>
                <a href={`/store/${encodeURIComponent(store.slug)}`}>
                  View Store
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">
            No approved Stores have published a custom theme.
          </p>
        )}
      </section>
      <section className="themeRevisionList themeAdminHistory">
        <h3>Catalog audit history</h3>
        {data.history.length ? (
          data.history.map((entry) => (
            <article key={entry.id}>
              <div>
                <strong>
                  {entry.actor?.name || entry.actor?.email || "Administrator"} ·{" "}
                  {entry.metadata?.reason || "Catalog configuration updated"}
                </strong>
                <small>{new Date(entry.createdAt).toLocaleString()}</small>
              </div>
              <span>
                {entry.metadata?.config?.displayOrder?.length ?? 0} themes
                retained
              </span>
            </article>
          ))
        ) : (
          <p className="empty">Catalog changes will be recorded here.</p>
        )}
      </section>
      <p>
        <a href="/admin/platform?section=plans">
          Manage Store Plan theme availability
        </a>
      </p>
    </section>
  );
}
