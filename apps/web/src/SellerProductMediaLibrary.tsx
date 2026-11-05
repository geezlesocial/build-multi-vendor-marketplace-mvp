import { useEffect, useRef, useState } from "react";
import {
  PRODUCT_MEDIA_ACCEPT,
  PRODUCT_MEDIA_LIMITS,
  productMediaCounts,
  productMediaKindForFile,
  uploadContentType,
  uploadToLocalApi,
  uploadToSignedPostWithType,
} from "./media-upload.js";
import {
  fallbackLimits,
  statusLabels,
  type DashboardRequest,
  type MediaAsset,
  type MediaLibraryResponse,
  type UploadEntry,
  type UploadProduct,
} from "./seller-product-media-types.js";

export function useSellerProductMedia({
  request,
  reload,
  setMessage,
}: {
  request: DashboardRequest;
  reload: () => void;
  setMessage: (message: string) => void;
}) {
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState("");
  const [uploadLimits, setUploadLimits] = useState(fallbackLimits);
  const [uploadEntries, setUploadEntries] = useState<UploadEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const uploadLock = useRef(false);
  const uploadSequence = useRef(0);

  const refreshMedia = async (silent = false) => {
    if (!silent) setMediaLoading(true);
    try {
      const result = await request<MediaLibraryResponse>(
        "/api/seller/store-media",
      );
      setMedia(result.assets);
      setUploadLimits({ ...fallbackLimits, ...result.uploadLimitsBytes });
      setMediaError("");
      setUploadEntries((current) =>
        current.map((entry) => {
          if (!entry.mediaAssetId || entry.status === "failed") return entry;
          const asset = result.assets.find(
            (item) => item.id === entry.mediaAssetId,
          );
          if (!asset || asset.uploadStatus !== "COMPLETE") return entry;
          if (asset.scanStatus === "APPROVED")
            return {
              ...entry,
              status: "approved",
              progress: 100,
              error: undefined,
            };
          if (asset.scanStatus === "REJECTED")
            return {
              ...entry,
              status: "rejected",
              progress: 100,
              error:
                "The malware scanner rejected this file. It remains private and cannot be attached.",
            };
          return { ...entry, status: "awaiting-scan", progress: 100 };
        }),
      );
      return result.assets;
    } catch (error) {
      const message = (error as Error).message;
      setMediaError(message);
      if (!silent) setMessage(`Media library: ${message}`);
      return null;
    } finally {
      if (!silent) setMediaLoading(false);
    }
  };

  useEffect(() => {
    void refreshMedia();
    // request is the stable dashboard transport; the key supports explicit retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, refreshKey]);

  useEffect(() => {
    const hasPending = media.some(
      (asset) =>
        asset.uploadStatus === "PENDING" ||
        asset.uploadStatus === "VERIFYING" ||
        (asset.uploadStatus === "COMPLETE" &&
          asset.scanStatus === "QUARANTINED"),
    );
    if (!hasPending) return undefined;
    const timer = window.setInterval(() => void refreshMedia(true), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, request]);

  const updateEntry = (key: string, update: Partial<UploadEntry>) => {
    setUploadEntries((current) =>
      current.map((entry) =>
        entry.key === key ? { ...entry, ...update } : entry,
      ),
    );
  };

  const uploadOne = async (entry: UploadEntry) => {
    updateEntry(entry.key, {
      status: "uploading",
      progress: 0,
      error: undefined,
    });
    try {
      const contentType = uploadContentType(entry.file);
      if (!contentType || !entry.kind)
        throw new Error("Choose a supported image, video, or document file.");
      const reservation = await request<{
        id: string;
        upload: {
          transport: "LOCAL" | "OBJECT";
          url: string;
          fields?: Record<string, string>;
        };
      }>("/api/seller/store-media/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: entry.file.name,
          contentType,
          sizeBytes: entry.file.size,
        }),
      });
      updateEntry(entry.key, { mediaAssetId: reservation.id });
      const reportProgress = (progress: number) => {
        setUploadProgress(progress);
        updateEntry(entry.key, { progress });
      };
      if (reservation.upload.transport === "LOCAL") {
        await uploadToLocalApi(
          reservation.upload.url,
          entry.file,
          reportProgress,
        );
      } else {
        await uploadToSignedPostWithType(
          reservation.upload.url,
          reservation.upload.fields ?? {},
          entry.file,
          reportProgress,
          contentType,
        );
      }
      const finalized = await request<{
        scanStatus: string;
        scanErrorCode?: string | null;
        message?: string;
      }>(
        `/api/seller/store-media/${encodeURIComponent(reservation.id)}/finalize`,
        {
          method: "POST",
          body: "{}",
        },
      );
      let attachmentError = "";
      if (finalized.scanStatus === "APPROVED" && entry.product) {
        try {
          await request(
            `/api/products/${encodeURIComponent(entry.product.id)}/media`,
            {
              method: "POST",
              body: JSON.stringify({
                mediaAssetId: reservation.id,
                label: entry.file.name.replace(/\.[^.]+$/, ""),
              }),
            },
          );
        } catch (error) {
          attachmentError = `The file is approved in your library but could not be attached: ${(error as Error).message}`;
        }
      }
      const status =
        finalized.scanStatus === "APPROVED"
          ? "approved"
          : finalized.scanStatus === "REJECTED"
            ? "rejected"
            : "awaiting-scan";
      updateEntry(entry.key, {
        status,
        progress: 100,
        error:
          attachmentError ||
          (status === "rejected"
            ? finalized.message ||
              "The scanner rejected this file. It remains private and cannot be attached."
            : status === "awaiting-scan"
              ? finalized.message ||
                "The file remains private until the required scanner approves it."
              : undefined),
      });
      if (status === "approved" && entry.product && !attachmentError) reload();
      if (status === "rejected")
        setMessage(
          `${entry.file.name} was rejected by the required media scan and remains private.`,
        );
      await refreshMedia(true);
    } catch (error) {
      const message = (error as Error).message;
      updateEntry(entry.key, { status: "failed", error: message });
      setMessage(`${entry.file.name}: ${message}`);
    }
  };

  const uploadFiles = async (files: File[], product?: UploadProduct) => {
    if (uploadLock.current) return;
    const counts = product ? productMediaCounts(product) : null;
    const entries = files.map((file) => {
      const kind = productMediaKindForFile(file.name);
      const contentType = uploadContentType(file);
      const key = `upload-${Date.now()}-${++uploadSequence.current}`;
      let error = "";
      if (!kind || !contentType)
        error =
          "Unsupported file type. Choose an image, video, or document type accepted here.";
      else if (file.size > uploadLimits[kind])
        error = `File exceeds the ${Math.ceil(uploadLimits[kind] / 1_000_000)} MB ${kind.toLowerCase()} limit.`;
      else if (counts && counts[kind] >= PRODUCT_MEDIA_LIMITS[kind])
        error = `This product has reached its ${kind.toLowerCase()} limit.`;
      if (counts && kind && !error) counts[kind] += 1;
      return {
        key,
        file,
        kind,
        status: error ? ("rejected" as const) : ("uploading" as const),
        progress: 0,
        ...(error ? { error } : {}),
        ...(product ? { product } : {}),
      };
    });
    setUploadEntries((current) => [...current, ...entries]);
    const accepted = entries.filter((entry) => entry.status === "uploading");
    if (!accepted.length) {
      const firstError = entries.find((entry) => entry.error)?.error;
      if (firstError) setMessage(firstError);
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setMessage("");
    try {
      for (const entry of accepted) await uploadOne(entry);
    } finally {
      uploadLock.current = false;
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const retryUpload = async (entry: UploadEntry) => {
    if (uploadLock.current || entry.status !== "failed") return;
    uploadLock.current = true;
    setUploading(true);
    setUploadProgress(0);
    try {
      await uploadOne(entry);
    } finally {
      uploadLock.current = false;
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const retryScan = async (assetId: string) => {
    try {
      const result = await request<{ scanStatus: string; message?: string }>(
        `/api/seller/store-media/${encodeURIComponent(assetId)}/scan-retry`,
        { method: "POST", body: "{}" },
      );
      setMessage(result.message ?? "Scan retry completed.");
      await refreshMedia(true);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const dismissUpload = (key: string) =>
    setUploadEntries((current) => current.filter((entry) => entry.key !== key));

  return {
    media,
    mediaLoading,
    mediaError,
    uploading,
    uploadProgress,
    uploadEntries,
    uploadFiles,
    retryUpload,
    retryScan,
    dismissUpload,
    retryMediaLoad: () => setRefreshKey((current) => current + 1),
  };
}

export function SellerProductMediaLibrary({
  media,
  mediaLoading,
  mediaError,
  uploading,
  uploadProgress,
  uploadEntries,
  uploadFiles,
  retryUpload,
  retryScan,
  dismissUpload,
  retryMediaLoad,
}: ReturnType<typeof useSellerProductMedia>) {
  return (
    <section
      className="setting sellerProductModule sellerMediaUpload"
      aria-labelledby="product-library-heading"
    >
      <header className="sellerSectionHeading">
        <span className="sellerStep">02</span>
        <div>
          <p className="eyebrow">Shared media</p>
          <h3 id="product-library-heading">Product media library</h3>
          <p className="muted">
            Uploads are private until the required scan approves them. Only
            approved files can be attached to a listing.
          </p>
        </div>
      </header>
      <label className="sellerMediaFilePicker">
        Choose images, video, or documents
        <input
          type="file"
          multiple
          accept={PRODUCT_MEDIA_ACCEPT}
          disabled={uploading}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.length) void uploadFiles(files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {mediaLoading && (
        <small role="status" aria-busy="true">
          Loading media library…
        </small>
      )}
      {mediaError && (
        <p className="notice" role="alert">
          Media library could not be loaded: {mediaError}{" "}
          <button type="button" onClick={retryMediaLoad}>
            Retry
          </button>
        </p>
      )}
      {uploadProgress !== null && (
        <progress
          value={uploadProgress}
          max="100"
          aria-label="Current file upload progress"
        />
      )}
      {uploadEntries.length > 0 && (
        <div
          className="sellerUploadQueue"
          aria-label="Selected file upload status"
          aria-live="polite"
        >
          {uploadEntries.map((entry) => (
            <article className="sellerUploadRow" key={entry.key}>
              {entry.mediaAssetId &&
                entry.kind === "IMAGE" &&
                entry.status === "approved" && (
                  <img
                    src={`/api/seller/store-media/${encodeURIComponent(entry.mediaAssetId)}/preview`}
                    alt={`Preview of ${entry.file.name}`}
                    loading="lazy"
                  />
                )}
              <div className="sellerUploadRowDetails">
                <strong>{entry.file.name}</strong>
                <span className={`sellerUploadStatus is-${entry.status}`}>
                  {statusLabels[entry.status]}
                </span>
                {entry.status === "uploading" && (
                  <progress
                    value={entry.progress}
                    max="100"
                    aria-label={`Uploading ${entry.file.name}`}
                  />
                )}
                {entry.error && (
                  <small
                    role={entry.status === "rejected" ? "alert" : "status"}
                  >
                    {entry.error}
                  </small>
                )}
              </div>
              <div className="sellerUploadRowActions">
                {entry.status === "failed" && (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => void retryUpload(entry)}
                  >
                    Retry
                  </button>
                )}
                {entry.status !== "uploading" && (
                  <button
                    type="button"
                    onClick={() => dismissUpload(entry.key)}
                  >
                    Dismiss status
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!mediaLoading && !mediaError && (
        <>
          <small>
            {media.length} asset(s) in your media library; pending, rejected,
            and failed assets cannot be attached.
          </small>
          <div
            className="sellerMediaAssetList"
            aria-label="Media library assets"
          >
            {media.map((asset) => {
              const status =
                asset.uploadStatus !== "COMPLETE"
                  ? asset.uploadStatus === "FAILED"
                    ? "Failed"
                    : "Uploading"
                  : asset.scanStatus === "APPROVED"
                    ? "Approved"
                    : asset.scanStatus === "REJECTED"
                      ? "Rejected"
                      : "Awaiting scan";
              return (
                <article className="sellerMediaAssetRow" key={asset.id}>
                  {asset.kind === "IMAGE" &&
                    asset.uploadStatus === "COMPLETE" &&
                    asset.scanStatus === "APPROVED" && (
                      <img
                        src={`/api/seller/store-media/${encodeURIComponent(asset.id)}/preview`}
                        alt={`Preview of ${asset.originalName}`}
                        loading="lazy"
                      />
                    )}
                  <div>
                    <strong>{asset.originalName}</strong>
                    <small>
                      {asset.kind} · {status}
                    </small>
                  </div>
                  {asset.uploadStatus === "COMPLETE" &&
                    asset.scanStatus === "QUARANTINED" && (
                      <button
                        type="button"
                        onClick={() => void retryScan(asset.id)}
                      >
                        Retry scan
                      </button>
                    )}
                </article>
              );
            })}
            {!media.length && (
              <p className="empty">
                No media uploaded yet. Choose files above to add them to your
                private library.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
