import type { CSSProperties } from "react";
import type {
  PreviewStore,
  Preset,
  Store,
  ThemeInfo,
  Tokens,
} from "./types.js";

export type PreviewDevice = "desktop" | "tablet" | "mobile";

type StoreThemeAdminPreviewProps = {
  previewPreset: Preset;
  previewTheme: ThemeInfo | undefined;
  previewTokens: Tokens;
  previewDevice: PreviewDevice;
  previewSlug: string;
  previewStore: PreviewStore | null;
  stores: Store[];
  previewImageUrl: string | undefined;
  onDeviceChange: (device: PreviewDevice) => void;
  onStoreChange: (slug: string) => void;
};

export function StoreThemeAdminPreview({
  previewPreset,
  previewTheme,
  previewTokens,
  previewDevice,
  previewSlug,
  previewStore,
  stores,
  previewImageUrl,
  onDeviceChange,
  onStoreChange,
}: StoreThemeAdminPreviewProps) {
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
    <section
      id="theme-admin-preview"
      className="card cardBody themeAdminPreview"
    >
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
              onClick={() => onDeviceChange(device)}
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
          onChange={(event) => onStoreChange(event.target.value)}
        >
          <option value="">Choose an approved Store</option>
          {stores.map((store) => (
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
          } as CSSProperties
        }
      >
        <div className="themePreviewTop">
          <strong>{previewStore?.name ?? "Store preview"}</strong>
          <span>Approved catalog</span>
          <small>Cart</small>
        </div>
        {previewTheme && (
          <img
            className="themePreviewReferenceImage"
            src={previewImageUrl ?? previewTheme.previewImageUrl}
            alt={`${previewTheme.name} theme reference preview`}
            loading="lazy"
            decoding="async"
          />
        )}
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
  );
}
