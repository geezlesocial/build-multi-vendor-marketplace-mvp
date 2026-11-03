import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api, uploadThemePreviewFile } from "./api.js";
import type { AdminData, Config, Preset, PreviewMedia } from "./types.js";

const maxThemePreviewBytes = 5_000_000;
const maxThemePreviewPixels = 40_000_000;

type UseThemePreviewMediaOptions = {
  data: AdminData | null;
  setData: Dispatch<SetStateAction<AdminData | null>>;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  expectedUpdatedAt: string | null;
  setExpectedUpdatedAt: (updatedAt: string | null) => void;
  setMessage: (message: string) => void;
};

export function useThemePreviewMedia({
  data,
  setData,
  setConfig,
  expectedUpdatedAt,
  setExpectedUpdatedAt,
  setMessage,
}: UseThemePreviewMediaOptions) {
  const [candidateUrls, setCandidateUrls] = useState<
    Partial<Record<Preset, string>>
  >({});
  const [selectedFiles, setSelectedFiles] = useState<
    Partial<Record<Preset, File>>
  >({});
  const [previewBusy, setPreviewBusy] = useState<Preset | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const candidateUrlSet = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const url of candidateUrlSet.current) URL.revokeObjectURL(url);
      candidateUrlSet.current.clear();
    },
    [],
  );

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

  return {
    candidateUrls,
    previewBusy,
    uploadProgress,
    rememberCandidate,
    applyPreviewImage,
    uploadPreviewImage,
    retryPreviewScan,
  };
}
