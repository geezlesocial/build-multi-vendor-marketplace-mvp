import { productMediaCounts } from "./media-upload.js";
import type { ProductMediaCounts, ProductMediaKind } from "./media-upload.js";

export type DashboardRequest = <T>(
  path: string,
  options?: RequestInit,
) => Promise<T>;

export type MediaAsset = {
  id: string;
  originalName: string;
  kind: string;
  detectedMime: string;
  sizeBytes: number;
  scanStatus: string;
  scanErrorCode?: string | null;
  uploadStatus: string;
  storageProvider: "LOCAL" | "OBJECT";
};

export type UploadProduct = { id: string; name: string } & Parameters<
  typeof productMediaCounts
>[0];

export type UploadEntry = {
  key: string;
  file: File;
  kind: ProductMediaKind | null;
  status: "uploading" | "awaiting-scan" | "approved" | "rejected" | "failed";
  progress: number;
  mediaAssetId?: string;
  error?: string;
  product?: UploadProduct;
};

export type MediaLibraryResponse = {
  assets: MediaAsset[];
  uploadLimitsBytes?: ProductMediaCounts;
  usedBytes?: number;
  limitBytes?: number;
};

export const fallbackLimits: ProductMediaCounts = {
  IMAGE: 5_000_000,
  VIDEO: 50_000_000,
  DOCUMENT: 10_000_000,
};

export const statusLabels: Record<UploadEntry["status"], string> = {
  uploading: "Uploading",
  "awaiting-scan": "Awaiting scan",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
};
