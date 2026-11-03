import React, { useEffect, useState } from "react";
import { StoreThemeAdminCards } from "./store-themes-admin/StoreThemeAdminCards.js";
import { StoreThemeAdminPreview } from "./store-themes-admin/StoreThemeAdminPreview.js";
import type { PreviewDevice } from "./store-themes-admin/StoreThemeAdminPreview.js";
import { StoreThemeAdminSummary } from "./store-themes-admin/StoreThemeAdminSummary.js";
import { api } from "./store-themes-admin/api.js";
import type {
  AdminData,
  CatalogPreviewResponse,
  Config,
  PreviewStore,
  Preset,
} from "./store-themes-admin/types.js";
import { useThemePreviewMedia } from "./store-themes-admin/useThemePreviewMedia.js";

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
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const [previewStore, setPreviewStore] = useState<PreviewStore | null>(null);
  const previewMedia = useThemePreviewMedia({
    data,
    setData,
    setConfig,
    expectedUpdatedAt,
    setExpectedUpdatedAt,
    setMessage,
  });

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

  const selectPreviewPreset = (preset: Preset, scrollToPreview: boolean) => {
    setPreviewPreset(preset);
    if (scrollToPreview)
      document.getElementById("theme-admin-preview")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
  };

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

  const previewTheme = data.themes.find((theme) => theme.id === previewPreset);
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
      <StoreThemeAdminCards
        data={data}
        config={config}
        busy={busy}
        candidateUrls={previewMedia.candidateUrls}
        previewPreset={previewPreset}
        previewBusy={previewMedia.previewBusy}
        uploadProgress={previewMedia.uploadProgress}
        setConfig={setConfig}
        onRememberCandidate={previewMedia.rememberCandidate}
        onPreviewPreset={selectPreviewPreset}
        onUploadPreview={(preset) =>
          void previewMedia.uploadPreviewImage(preset)
        }
        onApplyPreviewImage={(preset, assetId) =>
          void previewMedia.applyPreviewImage(preset, assetId)
        }
        onRetryPreviewScan={(preset, assetId) =>
          void previewMedia.retryPreviewScan(preset, assetId)
        }
        onMove={move}
      />
      <StoreThemeAdminPreview
        previewPreset={previewPreset}
        previewTheme={previewTheme}
        previewTokens={config.tokens[previewPreset]}
        previewDevice={previewDevice}
        previewSlug={previewSlug}
        previewStore={previewStore}
        stores={data.stores}
        previewImageUrl={previewMedia.candidateUrls[previewPreset]}
        onDeviceChange={setPreviewDevice}
        onStoreChange={setPreviewSlug}
      />
      <StoreThemeAdminSummary
        data={data}
        reason={reason}
        busy={busy}
        onReasonChange={setReason}
        onSave={() => void save()}
      />
    </section>
  );
}
