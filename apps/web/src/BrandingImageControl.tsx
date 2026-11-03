import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  cropRaster,
  requestMediaList,
  uploadToSignedPost,
  type Asset,
} from "./branding-image-transport.js";

export function BrandingImageControl({
  label,
  value,
  publishedValue,
  onChange,
  ratio,
  listUrl,
  uploadUrl,
  previewUrl,
  quota = false,
}: {
  label: string;
  value: string | null;
  publishedValue?: string | null;
  onChange: (id: string | null) => void;
  ratio: number;
  listUrl: string;
  uploadUrl: string;
  previewUrl: (id: string) => string;
  quota?: boolean;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [limitBytes, setLimitBytes] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [candidateUrl, setCandidateUrl] = useState<string | null>(null);
  const [focusX, setFocusX] = useState(0.5);
  const [focusY, setFocusY] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadAssets = useCallback(async () => {
    const result = await requestMediaList(listUrl);
    if (Array.isArray(result)) {
      setAssets(result);
      setUsedBytes(null);
      setLimitBytes(null);
    } else {
      setAssets(result.assets);
      setUsedBytes(result.usedBytes);
      setLimitBytes(result.limitBytes);
    }
  }, [listUrl]);
  useEffect(() => {
    void loadAssets().catch((reason) =>
      setError(
        reason instanceof Error
          ? reason.message
          : "Media library could not be loaded.",
      ),
    );
  }, [loadAssets]);
  useEffect(
    () => () => {
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
    },
    [candidateUrl],
  );

  const pick = (selected: File | undefined) => {
    setError("");
    setMessage("");
    setFile(null);
    if (candidateUrl) URL.revokeObjectURL(candidateUrl);
    setCandidateUrl(null);
    if (!selected) return;
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        selected.type,
      )
    ) {
      setError(
        "Choose a PNG, JPEG, WebP, or GIF image. SVG and other formats are not accepted.",
      );
      return;
    }
    const url = URL.createObjectURL(selected);
    setCandidateUrl(url);
    setFile(selected);
    setFocusX(0.5);
    setFocusY(0.5);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    setProgress(0);
    try {
      const cropped = await cropRaster(file, ratio, focusX, focusY);
      const reservation = await api<{
        id: string;
        upload: { url: string; fields: Record<string, string> };
      }>(uploadUrl, {
        method: "POST",
        body: JSON.stringify({
          fileName: cropped.name,
          contentType: cropped.type,
          sizeBytes: cropped.size,
        }),
      });
      await uploadToSignedPost(
        reservation.upload.url,
        reservation.upload.fields,
        cropped,
        (value) => setProgress(value),
      );
      const finalizeBase = uploadUrl.replace(/\/uploads$/, "");
      const finalized = await api<{
        scanStatus: string;
        uploadStatus: string;
        publicAfterUpload: boolean;
      }>(`${finalizeBase}/${encodeURIComponent(reservation.id)}/finalize`, {
        method: "POST",
        body: "{}",
      });
      if (
        finalized.uploadStatus !== "COMPLETE" ||
        finalized.scanStatus === "REJECTED" ||
        finalized.publicAfterUpload
      )
        throw new Error(
          "The server did not approve this image. The previous image remains selected.",
        );
      onChange(reservation.id);
      await loadAssets();
      setMessage(
        finalized.scanStatus === "APPROVED"
          ? "Image scanned and saved as a draft. Save and publish to make it public; the current public image remains active meanwhile."
          : "Image uploaded to private quarantine. It is not available publicly until scanning approves it; the current public image remains active meanwhile.",
      );
      setFile(null);
      setProgress(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Image replacement failed. The current published image remains active.",
      );
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const retryScan = async (id: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const endpoint = listUrl.includes("/api/admin/platform/")
        ? `/api/admin/platform/branding-media/${encodeURIComponent(id)}/scan-retry`
        : `/api/seller/store-media/${encodeURIComponent(id)}/scan-retry`;
      const result = await api<{
        scanStatus: string;
        scanErrorCode?: string | null;
      }>(endpoint, { method: "POST", body: "{}" });
      await loadAssets();
      setMessage(
        result.scanStatus === "APPROVED"
          ? "The malware scan approved this asset. You can select it and publish it."
          : result.scanErrorCode === "MALWARE_DETECTED"
            ? "The malware scanner rejected this asset. It remains private."
            : "The asset is still quarantined; the scanner is unavailable or has not completed.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The media scan could not be retried.",
      );
    } finally {
      setBusy(false);
    }
  };

  const formatBytes = (bytes: number) => new Intl.NumberFormat().format(bytes);
  const activeId = publishedValue === undefined ? value : publishedValue;
  return (
    <fieldset className="brandingImageControl">
      <legend>{label}</legend>
      <p className="muted">
        Select a shared media asset or upload from this device. Device-only
        previews are private to this browser.
      </p>
      {activeId ? (
        <div className="brandingImagePreview">
          <span>Currently public</span>
          <img
            src={previewUrl(activeId)}
            alt={`${label} currently published`}
            style={{ aspectRatio: `${ratio} / 1`, objectPosition: "50% 50%" }}
          />
        </div>
      ) : (
        <p className="empty brandingImageEmpty">
          No image is currently published.
        </p>
      )}
      <label>
        {label} from media library
        <select
          aria-label={`${label} from media library`}
          value={value ?? ""}
          onChange={(event) => {
            const id = event.target.value || null;
            onChange(id);
            setMessage(
              id
                ? "Draft image selected. Save and publish only after it is approved."
                : "Image removed from the draft. Save and publish to remove it publicly; the stored asset is retained.",
            );
            setError("");
          }}
        >
          <option value="">No image in draft</option>
          {assets
            .filter(
              (asset) =>
                asset.uploadStatus === "COMPLETE" &&
                asset.scanStatus !== "REJECTED" &&
                (asset.storageProvider === "OBJECT" ||
                  asset.storageProvider === "LOCAL") &&
                (asset.kind === undefined || asset.kind === "IMAGE"),
            )
            .map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.originalName} · {asset.scanStatus.toLowerCase()}
              </option>
            ))}
        </select>
      </label>
      {value && value !== activeId && (
        <div className="brandingImagePreview">
          <span>
            Draft preview ·{" "}
            {assets
              .find((asset) => asset.id === value)
              ?.scanStatus.toLowerCase() ?? "selected"}
          </span>
          <img
            src={previewUrl(value)}
            alt={`${label} draft preview`}
            style={{ aspectRatio: `${ratio} / 1` }}
          />
        </div>
      )}
      {quota && usedBytes !== null && limitBytes !== null && (
        <p className="muted">
          Store media usage: {formatBytes(usedBytes)} of{" "}
          {formatBytes(limitBytes)} bytes.
        </p>
      )}
      <label>
        Choose {label.toLowerCase()} image
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => pick(event.currentTarget.files?.[0])}
        />
      </label>
      {file && candidateUrl && (
        <div className="brandingImageCandidate">
          <p>Crop preview</p>
          <img
            src={candidateUrl}
            alt={`${label} crop preview`}
            style={{
              aspectRatio: `${ratio} / 1`,
              objectPosition: `${focusX * 100}% ${focusY * 100}%`,
            }}
          />
          <label>
            Horizontal crop position
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={focusX}
              onChange={(event) => setFocusX(Number(event.target.value))}
            />
          </label>
          <label>
            Vertical crop position
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={focusY}
              onChange={(event) => setFocusY(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void upload()}
          >
            {busy ? "Uploading…" : `Upload ${label.toLowerCase()} replacement`}
          </button>
          {progress !== null && (
            <progress
              max="100"
              value={progress}
              aria-label="Image upload progress"
            />
          )}
        </div>
      )}
      <button
        type="button"
        disabled={!value || busy}
        onClick={() => {
          onChange(null);
          setMessage(
            "Removed from draft only. Save and publish to remove the public image; stored media is retained for history and other references.",
          );
          setError("");
        }}
      >
        Remove from draft
      </button>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {assets
        .filter(
          (asset) =>
            asset.uploadStatus === "COMPLETE" &&
            asset.scanStatus === "QUARANTINED",
        )
        .map((asset) => (
          <div className="brandingMediaScanStatus" key={asset.id}>
            <p className="notice">
              {asset.originalName}: private, awaiting scan
              {asset.scanErrorCode
                ? ` (${asset.scanErrorCode.toLowerCase().replaceAll("_", " ")})`
                : ""}
              . The current published image remains active.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void retryScan(asset.id)}
            >
              Retry malware scan
            </button>
          </div>
        ))}
      {assets.some(
        (asset) => asset.id === value && asset.scanStatus !== "APPROVED",
      ) && (
        <p className="notice">
          This image is not approved yet. Publishing is blocked and the
          currently published image remains active.
        </p>
      )}
    </fieldset>
  );
}
