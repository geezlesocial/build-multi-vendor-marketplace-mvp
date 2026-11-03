import type { Dispatch, SetStateAction } from "react";
import {
  StoreThemeArtwork,
  themeContrastRatio,
} from "../store-theme-presentation.js";
import type { AdminData, Config, Preset, Tokens } from "./types.js";

type StoreThemeAdminCardsProps = {
  data: AdminData;
  config: Config;
  busy: boolean;
  candidateUrls: Partial<Record<Preset, string>>;
  previewPreset: Preset;
  previewBusy: Preset | null;
  uploadProgress: number | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  onRememberCandidate: (preset: Preset, file?: File) => void;
  onPreviewPreset: (preset: Preset, scrollToPreview: boolean) => void;
  onUploadPreview: (preset: Preset) => void;
  onApplyPreviewImage: (preset: Preset, assetId: string | null) => void;
  onRetryPreviewScan: (preset: Preset, assetId: string) => void;
  onMove: (index: number, delta: number) => void;
};

export function StoreThemeAdminCards({
  data,
  config,
  busy,
  candidateUrls,
  previewPreset,
  previewBusy,
  uploadProgress,
  setConfig,
  onRememberCandidate,
  onPreviewPreset,
  onUploadPreview,
  onApplyPreviewImage,
  onRetryPreviewScan,
  onMove,
}: StoreThemeAdminCardsProps) {
  return (
    <div className="themeAdminGrid">
      {config.displayOrder.map((preset, index) => {
        const item = data.themes.find((theme) => theme.id === preset);
        if (!item) return null;
        const tokens = config.tokens[preset];
        const lowAccentContrast =
          themeContrastRatio(tokens.accentColor, tokens.cardColor) < 4.5 ||
          themeContrastRatio(tokens.accentColor, tokens.surfaceColor) < 4.5;
        return (
          <article className="themeAdminCard" key={preset}>
            <StoreThemeArtwork
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
                  This is catalog artwork, not a seller’s Store logo. New images
                  are normalized, malware-scanned, and published only after
                  approval.
                </p>
                <label>
                  Replace {item.name} preview image
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={(event) => {
                      onRememberCandidate(
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
                  onClick={() => onPreviewPreset(preset, true)}
                >
                  View preview
                </button>
                {candidateUrls[preset] && (
                  <button
                    type="button"
                    className="primary"
                    disabled={previewBusy !== null}
                    onClick={() => onUploadPreview(preset)}
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
                                onApplyPreviewImage(preset, asset.id)
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
                            onClick={() => onRetryPreviewScan(preset, asset.id)}
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
                        onApplyPreviewImage(preset, null);
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
                  Accent contrast is below 4.5:1 on this theme&apos;s surface or
                  cards. Use an accessible link/accent color before publishing
                  defaults.
                </p>
              )}
              <div className="themeOrderControls">
                <span>Catalog position {index + 1}</span>
                <button
                  type="button"
                  onClick={() => onPreviewPreset(preset, false)}
                >
                  Preview this theme
                </button>
                <button
                  type="button"
                  aria-label={`Move ${item.name} up`}
                  disabled={busy || index === 0}
                  onClick={() => onMove(index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  aria-label={`Move ${item.name} down`}
                  disabled={busy || index === config.displayOrder.length - 1}
                  onClick={() => onMove(index, 1)}
                >
                  Move down
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
