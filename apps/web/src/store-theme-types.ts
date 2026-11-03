export type ThemePreset =
  | "CLASSIC"
  | "EDITORIAL"
  | "BOUTIQUE"
  | "TECH_ELECTRONICS"
  | "GROCERIES"
  | "ECOMMERCE_MARKETPLACE";

export type SectionType =
  | "featuredProducts"
  | "categories"
  | "promotion"
  | "productCollection"
  | "brandHighlights";

export type Theme = {
  themePreset: ThemePreset;
  mobileTemplate: string;
  description: string;
  heroTitle: string;
  heroSubtitle: string;
  heroButtonLabel: string;
  heroButtonHref: string;
  primaryColor: string;
  accentColor: string;
  font: string;
  gridDensity: "comfortable" | "standard" | "dense";
  cardStyle: "standard" | "editorial" | "soft" | "technical";
  sections: {
    type: SectionType;
    title: string;
    productIds: string[];
    categorySlug: string | null;
    visible: boolean;
  }[];
  contactLinks: { label: string; url: string }[];
  logoMediaId: string | null;
  faviconMediaId: string | null;
  bannerMediaId: string | null;
};

export type CatalogTheme = {
  id: ThemePreset;
  name: string;
  tier: "FREE" | "PAID";
  description: string;
  features: readonly string[];
  previewImageUrl: string;
  defaultTokens: {
    surfaceColor: string;
    cardColor: string;
    textColor: string;
    mutedColor: string;
    accentColor: string;
  };
};

export type Revision = {
  id: string;
  version: number;
  themeJson: Theme;
  changeNote: string | null;
  createdAt: string;
  editor: { name: string | null; email: string };
};

export type ThemeProductOption = {
  id: string;
  name: string;
  category: { name: string; slug: string } | null;
};

export type ThemePreviewProduct = ThemeProductOption & {
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  availableStock: number;
  images: { url: string; alt: string }[];
};
