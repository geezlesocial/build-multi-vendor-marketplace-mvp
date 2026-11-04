const defaultProductTypeIds = new Set([
  "ct_physical_default",
  "ct_digital_default",
  "ct_downloadable_default",
  "ct_service_default",
]);

export function catalogDefaultSuppressionKey(kind: string, id: string) {
  if (kind === "productType" && defaultProductTypeIds.has(id)) return id;
  const prefix =
    kind === "category"
      ? "catalog-default-category-"
      : kind === "brand"
        ? "catalog-default-brand-"
        : kind === "feature"
          ? "catalog-default-feature-"
          : "";
  return prefix && id.startsWith(prefix) ? id : null;
}
