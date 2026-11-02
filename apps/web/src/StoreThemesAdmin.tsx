import React, { useEffect, useRef, useState } from "react";

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
  previewImageUrl: string;
  defaultTokens: Tokens;
};
type Config = {
  displayOrder: Preset[];
  visibleThemes: Preset[];
  tokens: Record<Preset, Tokens>;
  previewImages: Partial<Record<Preset, string>>;
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
type PreviewMedia = {
  id: string;
  originalName: string;
  scanStatus: "QUARANTINED" | "REJECTED" | "APPROVED";
  scanErrorCode: string | null;
  uploadStatus: string;
  createdAt: string;
};
type AdminData = {
  themes: ThemeInfo[];
  config: Config;
  configUpdatedAt: string | null;
  usage: Record<Preset, number>;
  stores: Store[];
  history: Audit[];
  previewMedia: PreviewMedia[];
};
type CatalogPreviewResponse = {
  themes: ThemeInfo[];
  configUpdatedAt: string | null;
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
const maxThemePreviewBytes = 5_000_000;
const maxThemePreviewPixels = 40_000_000;

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

function ThemeArtwork({
  preset,
  name,
  src,
}: {
  preset: Preset;
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

function uploadThemePreviewFile(
  url: string,
  fields: Record<string, string>,
  file: File,
  progress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const localUpload = fields["x-local-upload"] === "1";
    request.open(localUpload ? "PUT" : "POST", url);
    request.withCredentials = false;
    request.timeout = 120_000;
    if (localUpload) {
      request.setRequestHeader("Content-Type", file.type);
      const csrf = document.cookie
        .split("; ")
        .find((value) => value.startsWith("marketplace_csrf="))
        ?.split("=")[1];
      if (csrf) request.setRequestHeader("x-csrf-token", csrf);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(
            new Error(
              "Media storage rejected the upload; the current theme image remains active.",
            ),
          );
    request.onerror = () =>
      reject(
        new Error(
          "Media storage could not be reached; the current theme image remains active.",
        ),
      );
    request.ontimeout = () =>
      reject(
        new Error(
          "The image upload timed out; the current theme image remains active.",
        ),
      );
    if (localUpload) {
      request.send(file);
      return;
    }
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    form.append("file", file);
    request.send(form);
  });
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
  const [candidateUrls, setCandidateUrls] = useState<
    Partial<Record<Preset, string>>
  >({});
  const [selectedFiles, setSelectedFiles] = useState<
    Partial<Record<Preset, File>>
  >({});
  const [previewBusy, setPreviewBusy] = useState<Preset | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const candidateUrlSet = useRef(new Set<string>());

  const load = async () => {
    const result = await api<AdminData>("/api/admin/store-themes");
    setData(result);
    setConfig(result.config);
    setExpectedUpdatedAt(result.configUpdatedAt);
  };
  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
  }, []);
  useEffect(
    () => () => {
      for (const url of candidateUrlSet.current) URL.revokeObjectURL(url);
      candidateUrlSet.current.clear();
    },
    [],
  );
  useEffect(() => {
    let active = true;
    const refreshPreviewImages = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await api<CatalogPreviewResponse>(
          "/api/store-themes/catalog",
        );
        if (active)
          setData((current) =>
            current ? { ...current, themes: result.themes } : current,
          );
      } catch {
        /* The current, already-loaded catalog remains usable during a transient refresh failure. */
      }
    };
    const timer = window.setInterval(() => void refreshPreviewImages(), 15_000);
    document.addEventListener("visibilitychange", refreshPreviewImages);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshPreviewImages);
    };
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

  const rememberCandidate = (preset: Preset, file?: File) => {
    const prior = candidateUrls[preset];
    if (prior) {
      URL.revokeObjectURL(prior);
      candidateUrlSet.current.delete(prior);
    }
    setSelectedFiles((current) => ({ ...current, [preset]: file }));
    if (!file) {
      setCandidateUrls((current) => {
        const next = { ...current };
        delete next[preset];
        return next;
      });
      return;
    }
    const url = URL.createObjectURL(file);
    candidateUrlSet.current.add(url);
    setCandidateUrls((current) => ({ ...current, [preset]: url }));
  };

  const applyPreviewImage = async (preset: Preset, assetId: string | null) => {
    const item = data?.themes.find((theme) => theme.id === preset);
    if (!item) return;
    setPreviewBusy(preset);
    setMessage(
      assetId
        ? `Applying the approved ${item.name} theme preview…`
        : `Restoring the default ${item.name} preview…`,
    );
    try {
      const result = await api<{
        previewImageUrl: string;
        configUpdatedAt: string;
      }>(
        `/api/admin/store-themes/${encodeURIComponent(preset)}/preview-image`,
        {
          method: "PUT",
          body: JSON.stringify({
            assetId,
            expectedUpdatedAt,
            reason: `${assetId ? "Updated" : "Restored default"} ${item.name} theme preview image`,
          }),
        },
      );
      setExpectedUpdatedAt(result.configUpdatedAt);
      setConfig((current) => {
        if (!current) return current;
        const previewImages = { ...current.previewImages };
        if (assetId) previewImages[preset] = assetId;
        else delete previewImages[preset];
        return { ...current, previewImages };
      });
      setData((current) =>
        current
          ? {
              ...current,
              configUpdatedAt: result.configUpdatedAt,
              themes: current.themes.map((theme) =>
                theme.id === preset
                  ? { ...theme, previewImageUrl: result.previewImageUrl }
                  : theme,
              ),
            }
          : current,
      );
      rememberCandidate(preset);
      setMessage(
        `${item.name} theme preview updated. The approved image is now visible in the admin and seller theme catalogs.`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setPreviewBusy(null);
      setUploadProgress(null);
    }
  };

  const uploadPreviewImage = async (preset: Preset) => {
    const file = selectedFiles[preset];
    const item = data?.themes.find((theme) => theme.id === preset);
    if (!file || !item) return;
    if (
      !(
        ["image/jpeg", "image/png", "image/webp", "image/gif"] as string[]
      ).includes(file.type)
    ) {
      setMessage(
        "Choose a JPEG, PNG, WebP, or GIF image. SVG and HTML uploads are not accepted.",
      );
      return;
    }
    setPreviewBusy(preset);
    setMessage(`Uploading and scanning the ${item.name} theme preview…`);
    setUploadProgress(0);
    try {
      if (file.size > maxThemePreviewBytes)
        throw new Error("Theme preview images must be 5 MB or smaller.");
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(file);
        try {
          if (
            bitmap.width <= 0 ||
            bitmap.height <= 0 ||
            bitmap.width * bitmap.height > maxThemePreviewPixels
          )
            throw new Error(
              "The image dimensions are invalid or exceed the 40-megapixel safety limit.",
            );
        } finally {
          bitmap.close();
        }
      }
      const reservation = await api<{
        id: string;
        upload: { url: string; fields: Record<string, string> };
      }>(
        `/api/admin/store-themes/${encodeURIComponent(preset)}/preview-media/uploads`,
        {
          method: "POST",
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
        },
      );
      await uploadThemePreviewFile(
        reservation.upload.url,
        reservation.upload.fields,
        file,
        setUploadProgress,
      );
      const finalized = await api<{
        scanStatus: string;
        scanErrorCode?: string | null;
        uploadStatus: string;
        message?: string;
      }>(
        `/api/admin/platform/branding-media/${encodeURIComponent(reservation.id)}/finalize`,
        { method: "POST", body: "{}" },
      );
      const mediaRecord: PreviewMedia = {
        id: reservation.id,
        originalName: `${preset}--${file.name}`,
        scanStatus:
          finalized.scanStatus === "APPROVED"
            ? "APPROVED"
            : finalized.scanStatus === "REJECTED"
              ? "REJECTED"
              : "QUARANTINED",
        scanErrorCode: finalized.scanErrorCode ?? null,
        uploadStatus: finalized.uploadStatus,
        createdAt: new Date().toISOString(),
      };
      setData((current) =>
        current
          ? {
              ...current,
              previewMedia: [
                mediaRecord,
                ...current.previewMedia.filter(
                  (asset) => asset.id !== mediaRecord.id,
                ),
              ],
            }
          : current,
      );
      if (finalized.uploadStatus !== "COMPLETE")
        throw new Error(
          finalized.message ??
            "The image upload could not be completed. The currently published theme preview remains active.",
        );
      if (finalized.scanStatus === "REJECTED") {
        setMessage(
          finalized.message ??
            "The scanner rejected this image. The currently published theme preview remains active.",
        );
        return;
      }
      if (finalized.scanStatus !== "APPROVED") {
        if (finalized.scanStatus === "REJECTED") {
          setMessage(
            finalized.message ??
              "The scanner rejected this image. The current theme preview is unchanged.",
          );
          return;
        }
        setMessage(
          "The upload is safely quarantined while scanning is unavailable. It is not public; retry the scan when the scanner is ready.",
        );
        return;
      }
      await applyPreviewImage(preset, reservation.id);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setPreviewBusy(null);
      setUploadProgress(null);
    }
  };

  const retryPreviewScan = async (preset: Preset, assetId: string) => {
    setPreviewBusy(preset);
    try {
      const result = await api<{
        scanStatus: string;
        scanErrorCode?: string | null;
      }>(
        `/api/admin/platform/branding-media/${encodeURIComponent(assetId)}/scan-retry`,
        { method: "POST", body: "{}" },
      );
      setData((current) =>
        current
          ? {
              ...current,
              previewMedia: current.previewMedia.map((asset) =>
                asset.id === assetId
                  ? {
                      ...asset,
                      scanStatus:
                        result.scanStatus === "APPROVED"
                          ? "APPROVED"
                          : result.scanStatus === "REJECTED"
                            ? "REJECTED"
                            : "QUARANTINED",
                      scanErrorCode: result.scanErrorCode ?? null,
                    }
                  : asset,
              ),
            }
          : current,
      );
      if (result.scanStatus === "APPROVED")
        await applyPreviewImage(preset, assetId);
      else if (result.scanErrorCode === "MALWARE_DETECTED") {
        setMessage(
          "The scanner rejected the upload. It remains private and the existing theme preview is unchanged.",
        );
      } else
        setMessage(
          "The image remains private in quarantine; try again when scanning is available.",
        );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setPreviewBusy(null);
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
              <ThemeArtwork
                preset={preset}
                name={item.name}
                src={candidateUrls[preset] ?? item.previewImageUrl}
              />
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
                <fieldset className="themePreviewImageControl">
                  <legend>Theme catalog preview image</legend>
                  <p className="muted">
                    This is catalog artwork, not a seller’s Store logo. New
                    images are normalized, malware-scanned, and published only
                    after approval.
                  </p>
                  <label>
                    Replace {item.name} preview image
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      onChange={(event) => {
                        rememberCandidate(
                          preset,
                          event.currentTarget.files?.[0],
                        );
                        event.currentTarget.value = "";
                      }}
                      disabled={previewBusy !== null}
                    />
                  </label>
                  <button
                    type="button"
                    aria-pressed={previewPreset === preset}
                    onClick={() => {
                      setPreviewPreset(preset);
                      document
                        .getElementById("theme-admin-preview")
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                    }}
                  >
                    View preview
                  </button>
                  {candidateUrls[preset] && (
                    <button
                      type="button"
                      className="primary"
                      disabled={previewBusy !== null}
                      onClick={() => void uploadPreviewImage(preset)}
                    >
                      {previewBusy === preset
                        ? "Uploading…"
                        : `Upload & publish ${item.name} preview`}
                    </button>
                  )}
                  {previewBusy === preset && uploadProgress !== null && (
                    <progress
                      max="100"
                      value={uploadProgress}
                      aria-label={`${item.name} preview upload progress`}
                    />
                  )}
                  {data.previewMedia
                    .filter(
                      (asset) =>
                        asset.originalName.startsWith(`${preset}--`) &&
                        asset.uploadStatus === "COMPLETE",
                    )
                    .map((asset) => (
                      <p className="muted" key={asset.id}>
                        {asset.originalName.slice(preset.length + 2)}:{" "}
                        {asset.scanStatus === "REJECTED" ? (
                          "rejected by the malware scanner; the image remains private."
                        ) : asset.scanStatus === "APPROVED" ? (
                          <>
                            approved and private until selected.{" "}
                            {config.previewImages[preset] !== asset.id && (
                              <button
                                type="button"
                                disabled={previewBusy !== null}
                                onClick={() =>
                                  void applyPreviewImage(preset, asset.id)
                                }
                              >
                                Publish approved preview
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            private pending malware scan.{" "}
                            <button
                              type="button"
                              disabled={previewBusy !== null}
                              onClick={() =>
                                void retryPreviewScan(preset, asset.id)
                              }
                            >
                              Retry scan
                            </button>
                          </>
                        )}
                      </p>
                    ))}
                  {config.previewImages[preset] && (
                    <button
                      type="button"
                      disabled={previewBusy !== null}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Restore the original ${item.name} theme preview image for all users?`,
                          )
                        )
                          void applyPreviewImage(preset, null);
                      }}
                    >
                      Restore default image
                    </button>
                  )}
                </fieldset>
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
          {previewTheme && (
            <img
              className="themePreviewReferenceImage"
              src={candidateUrls[previewPreset] ?? previewTheme.previewImageUrl}
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
