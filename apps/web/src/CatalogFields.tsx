import { useEffect, useId, useRef, useState } from "react";
import { CatalogSearchableOption } from "./CatalogSearchableOption.js";

export type CatalogCategory = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
};
export type CatalogBrand = { id: string; name: string; slug: string };
export type CatalogProductType = {
  id: string;
  name: string;
  slug: string;
  requiresShipping: boolean;
};
type CatalogFeature = {
  id: string;
  name: string;
  categoryId: string | null;
  productTypeId: string | null;
};

async function catalogRequest<T>(
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

function categoryPath(categoryId: string, categories: CatalogCategory[]) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const result: CatalogCategory[] = [];
  let category = byId.get(categoryId);
  while (category && result.length < 3) {
    result.unshift(category);
    category = category.parentId ? byId.get(category.parentId) : undefined;
  }
  return result;
}

export function CatalogFields({
  categories,
  brands,
  productTypes,
  categoryId,
  brandId,
  productTypeId,
  color,
  featureIds,
  onCategoryChange,
  onBrandChange,
  onProductTypeChange,
  onColorChange,
  onFeatureIdsChange,
  onMessage,
}: {
  categories: CatalogCategory[];
  brands: CatalogBrand[];
  productTypes: CatalogProductType[];
  categoryId: string | null;
  brandId: string | null;
  productTypeId: string;
  color: string;
  featureIds: string[];
  onCategoryChange: (value: string | null) => void;
  onBrandChange: (value: string | null) => void;
  onProductTypeChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onFeatureIdsChange: (value: string[]) => void;
  onMessage: (value: string) => void;
}) {
  const [path, setPath] = useState<CatalogCategory[]>([]);
  const [features, setFeatures] = useState<CatalogFeature[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featureQuery, setFeatureQuery] = useState("");
  const [featureError, setFeatureError] = useState("");
  const colorListId = useId();
  const featureIdsRef = useRef(featureIds);
  featureIdsRef.current = featureIds;
  const onFeatureIdsChangeRef = useRef(onFeatureIdsChange);
  onFeatureIdsChangeRef.current = onFeatureIdsChange;

  useEffect(
    () => setPath(categoryId ? categoryPath(categoryId, categories) : []),
    [categoryId, categories],
  );
  useEffect(() => {
    let active = true;
    setFeaturesLoading(true);
    const params = new URLSearchParams();
    if (categoryId) params.set("categoryId", categoryId);
    if (productTypeId) params.set("productTypeId", productTypeId);
    const url = `/api/catalog/features${params.size ? `?${params}` : ""}`;
    catalogRequest<CatalogFeature[]>(url)
      .then((items) => {
        if (!active) return;
        setFeatures(items);
        setFeatureError("");
        onFeatureIdsChangeRef.current(
          featureIdsRef.current.filter((id) =>
            items.some((item) => item.id === id),
          ),
        );
      })
      .catch((error) => {
        if (active) setFeatureError((error as Error).message);
      })
      .finally(() => {
        if (active) setFeaturesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [categoryId, productTypeId]);

  const categoriesAt = (level: number) =>
    categories.filter((category) =>
      level === 0
        ? !category.parentId
        : category.parentId === path[level - 1]?.id,
    );
  const chooseCategory = (level: number, id: string) => {
    const nextPath = id
      ? [
          ...path.slice(0, level),
          categories.find((category) => category.id === id)!,
        ]
      : path.slice(0, Math.max(0, level));
    setPath(nextPath);
    onCategoryChange(nextPath.at(-1)?.id ?? null);
    onFeatureIdsChange([]);
  };
  const toggleFeature = (id: string) => {
    if (featureIds.includes(id))
      onFeatureIdsChange(featureIds.filter((item) => item !== id));
    else if (featureIds.length < 30) onFeatureIdsChange([...featureIds, id]);
    else onMessage("Select no more than 30 product features.");
  };

  return (
    <div className="catalogFields">
      <p className="catalogHelp">
        Choose a product type and category. Shipping behavior and available
        features follow the selected type.
      </p>
      <label>
        Product type
        <CatalogSearchableOption
          label="Product type"
          value={productTypeId}
          options={productTypes.map((type) => ({
            value: type.id,
            label: `${type.name}${type.requiresShipping ? " · ships to buyer" : " · digital / no shipping"}`,
          }))}
          placeholder="Search product types"
          emptyLabel="No product type selected"
          required
          onChange={(event) => {
            onProductTypeChange(event);
            onFeatureIdsChange([]);
          }}
        />
      </label>
      {[0, 1, 2].map((level) => {
        const options = categoriesAt(level);
        if (level > 0 && !path[level - 1]) return null;
        if (level > 0 && options.length === 0) return null;
        return (
          <label key={level}>
            {level === 0
              ? "Category"
              : level === 1
                ? "Child category"
                : "Further subcategory"}
            <CatalogSearchableOption
              label={level === 0 ? "Category" : level === 1 ? "Child category" : "Further subcategory"}
              value={path[level]?.id ?? ""}
              options={options.map((category) => ({ value: category.id, label: category.name }))}
              placeholder={`Search ${level === 0 ? "categories" : "child categories"}`}
              emptyLabel={level === 0 ? "No category selected" : "Clear this level"}
              required={level === 0}
              onChange={(id) => chooseCategory(level, id)}
            />
          </label>
        );
      })}
      <label>
        Brand
        <CatalogSearchableOption
          label="Brand"
          value={brandId ?? ""}
          options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
          placeholder="Search brands"
          emptyLabel="Unbranded / no brand"
          onChange={(value) => onBrandChange(value || null)}
        />
      </label>
      <label>
        Color
        <input
          list={colorListId}
          maxLength={80}
          value={color}
          onChange={(event) => onColorChange(event.target.value)}
          placeholder="Choose or enter a color"
        />
        <datalist id={colorListId}>
          {[
            "Black",
            "White",
            "Gray",
            "Brown",
            "Beige",
            "Red",
            "Orange",
            "Yellow",
            "Green",
            "Blue",
            "Purple",
            "Pink",
            "Multicolor",
            "Clear",
            "Gold",
            "Silver",
          ].map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </label>
      <fieldset className="catalogFeatureChoices">
        <legend>Product features</legend>
        {featuresLoading ? (
          <small role="status" aria-busy="true">Loading approved features…</small>
        ) : features.length ? (
          <label className="catalogFeatureSearch">
            Search features
            <input
              type="search"
              value={featureQuery}
              onChange={(event) => setFeatureQuery(event.target.value)}
              placeholder="Type to filter features"
            />
          </label>
        ) : null}
        {!featuresLoading && features.length ? (
          <div className="catalogFeatureGrid">
            {features
              .filter((feature) => feature.name.toLocaleLowerCase().includes(featureQuery.trim().toLocaleLowerCase()))
              .map((feature) => (
              <label className="catalogFeatureChoice" key={feature.id}>
                <input
                  type="checkbox"
                  checked={featureIds.includes(feature.id)}
                  onChange={() => toggleFeature(feature.id)}
                />
                {feature.name}
              </label>
              ))}
          </div>
        ) : !featuresLoading ? (
          <small>
            {productTypeId || categoryId
              ? "No features have been approved for this product type/category yet."
              : "Select a product type and category to see relevant features."}
          </small>
        ) : null}
        {!featuresLoading && features.length > 0 && !features.some((feature) => feature.name.toLocaleLowerCase().includes(featureQuery.trim().toLocaleLowerCase())) && (
          <small role="status">No approved feature matches that search. Use the suggestion request below if the feature is missing.</small>
        )}
        {featureIds.length > 0 && <small>{featureIds.length} feature(s) selected.</small>}
        {featureError && (
          <p className="catalogFieldError" role="alert">
            {featureError}
          </p>
        )}
      </fieldset>
      <CatalogSuggestionTools
        categoryId={categoryId}
        canSuggestChild={path.length < 3}
        onMessage={onMessage}
      />
    </div>
  );
}

function CatalogSuggestionTools({
  categoryId,
  canSuggestChild,
  onMessage,
}: {
  categoryId: string | null;
  canSuggestChild: boolean;
  onMessage: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="catalogSuggestions"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Suggest a missing category, feature, or brand</summary>
      <p>
        Suggestions are reviewed by the marketplace team before they become
        selectable.
      </p>
      <div className="catalogSuggestionGrid">
        <SuggestionForm
          kind="CATEGORY"
          title="New product type / category"
          onMessage={onMessage}
        />
        {categoryId && canSuggestChild && (
          <SuggestionForm
            kind="CHILD_CATEGORY"
            title="Child category"
            parentCategoryId={categoryId}
            onMessage={onMessage}
          />
        )}
        {categoryId && (
          <SuggestionForm
            kind="FEATURE"
            title="Feature for this product type"
            categoryId={categoryId}
            onMessage={onMessage}
          />
        )}
        <SuggestionForm kind="BRAND" title="Brand" onMessage={onMessage} />
      </div>
    </details>
  );
}

function SuggestionForm({
  kind,
  title,
  parentCategoryId,
  categoryId,
  onMessage,
}: {
  kind: "CATEGORY" | "CHILD_CATEGORY" | "FEATURE" | "BRAND";
  title: string;
  parentCategoryId?: string;
  categoryId?: string;
  onMessage: (value: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const body = {
      kind,
      name,
      ...(parentCategoryId ? { parentCategoryId } : {}),
      ...(kind === "FEATURE" ? { categoryId: categoryId ?? null } : {}),
    };
    try {
      await catalogRequest("/api/catalog/suggestions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setName("");
      onMessage(`${title} suggestion submitted for review.`);
    } catch (error) {
      onMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="catalogSuggestionForm">
      <label>
        {title}
        <input
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={`Enter ${title.toLocaleLowerCase()}`}
        />
      </label>
      <button
        type="button"
        disabled={saving || !name.trim()}
        onClick={() => void submit()}
      >
        {saving ? "Submitting…" : "Suggest"}
      </button>
    </div>
  );
}
