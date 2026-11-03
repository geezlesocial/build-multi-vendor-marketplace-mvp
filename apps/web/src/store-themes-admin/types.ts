import type { ThemePreset } from "../store-theme-types.js";

export type Preset = ThemePreset;

export type Tokens = {
  surfaceColor: string;
  cardColor: string;
  textColor: string;
  mutedColor: string;
  accentColor: string;
};

export type ThemeInfo = {
  id: Preset;
  name: string;
  tier: "FREE" | "PAID";
  description: string;
  features: string[];
  previewImageUrl: string;
  defaultTokens: Tokens;
};

export type Config = {
  displayOrder: Preset[];
  visibleThemes: Preset[];
  tokens: Record<Preset, Tokens>;
  previewImages: Partial<Record<Preset, string>>;
};

export type Store = {
  id: string;
  name: string;
  slug: string;
  isPlatformStore: boolean;
  themePreset: string | null;
  publishedAt: string | null;
};

export type Audit = {
  id: string;
  createdAt: string;
  metadata: { reason?: string; config?: Config } | null;
  actor: { name: string | null; email: string } | null;
};

export type PreviewMedia = {
  id: string;
  originalName: string;
  scanStatus: "QUARANTINED" | "REJECTED" | "APPROVED";
  scanErrorCode: string | null;
  uploadStatus: string;
  createdAt: string;
};

export type AdminData = {
  themes: ThemeInfo[];
  config: Config;
  configUpdatedAt: string | null;
  usage: Record<Preset, number>;
  stores: Store[];
  history: Audit[];
  previewMedia: PreviewMedia[];
};

export type CatalogPreviewResponse = {
  themes: ThemeInfo[];
  configUpdatedAt: string | null;
};

export type PreviewStore = {
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
