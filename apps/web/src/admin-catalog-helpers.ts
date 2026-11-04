export type Category = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  imageUrl?: string | null;
  parentId: string | null;
  parent?: { id: string; name: string } | null;
  status: string;
  displayOrder: number;
  _count?: { products: number; children: number };
};
export type Brand = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  imageUrl?: string | null;
  status: string;
  displayOrder: number;
  _count?: { products: number };
};
export type ProductType = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  requiresShipping: boolean;
  status: string;
  displayOrder: number;
  _count: { products: number; features: number };
};
export type Feature = {
  id: string;
  name: string;
  slug: string;
  status: string;
  categoryId: string | null;
  productTypeId: string | null;
  displayOrder: number;
  category: { id: string; name: string } | null;
  productType: { id: string; name: string } | null;
  _count: { products: number };
};
export type Suggestion = {
  id: string;
  kind: string;
  name: string;
  status: string;
  createdAt: string;
  parentCategory: { id: string; name: string } | null;
  featureCategory: { id: string; name: string } | null;
  submittedBy: { id: string; name: string; email: string };
};
export type EntityKind = "category" | "brand" | "productType" | "feature";
export type CatalogEntity = Category | Brand | ProductType | Feature;
export type EditValues = Record<string, string | number | boolean | null>;
export type SaveAction = (
  work: () => Promise<unknown>,
  success: string,
) => Promise<boolean>;

export async function catalogApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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
    throw new Error(body.error ?? "Catalog request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function catalogSlugSuggestion(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘'`]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 140);
}

export function catalogImageId(imageUrl?: string | null) {
  if (!imageUrl) return null;
  const match = /^\/content-media\/([A-Za-z0-9_-]{1,100})$/.exec(imageUrl);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function catalogImageUrl(mediaId: string | null) {
  return mediaId ? `/content-media/${encodeURIComponent(mediaId)}` : null;
}

export function catalogInitials(name: string) {
  const words = name
    .trim()
    .split(/[\s&/+-]+/u)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}
