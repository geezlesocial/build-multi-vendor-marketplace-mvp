import { useState, type FormEvent } from "react";
import { CatalogImageField } from "./CatalogImageField.js";
import {
  catalogApi,
  catalogInitials,
  catalogSlugSuggestion,
  type Category,
  type ProductType,
  type SaveAction,
} from "./admin-catalog-helpers.js";

const slugPattern = "[a-z0-9]+(?:-[a-z0-9]+)*";

export function AdminCatalogCreateForms({
  categories,
  productTypes,
  categoryLabel,
  perform,
  saving,
}: {
  categories: Category[];
  productTypes: ProductType[];
  categoryLabel: (category: Category) => string;
  perform: SaveAction;
  saving: boolean;
}) {
  const [category, setCategory] = useState({
    name: "",
    slug: "",
    parentId: "",
    imageUrl: null as string | null,
  });
  const [brand, setBrand] = useState({
    name: "",
    slug: "",
    imageUrl: null as string | null,
  });
  const [productType, setProductType] = useState({
    name: "",
    slug: "",
    description: "",
    requiresShipping: true,
    displayOrder: 0,
  });
  const [feature, setFeature] = useState({
    name: "",
    categoryId: "",
    productTypeId: "",
  });
  const [manualSlug, setManualSlug] = useState({
    category: false,
    brand: false,
    productType: false,
  });

  const create = async (
    event: FormEvent<HTMLFormElement>,
    path: string,
    body: unknown,
    success: string,
    reset: () => void,
  ) => {
    event.preventDefault();
    if (saving) return;
    if (
      await perform(
        () => catalogApi(path, { method: "POST", body: JSON.stringify(body) }),
        success,
      )
    ) {
      reset();
    }
  };
  const createSlugField = (
    kind: keyof typeof manualSlug,
    value: { name: string; slug: string },
    update: (next: { name: string; slug: string }) => void,
  ) => {
    const suggestion = catalogSlugSuggestion(value.name);
    const touched = manualSlug[kind];
    const setName = (name: string) =>
      update({
        ...value,
        name,
        slug: touched ? value.slug : catalogSlugSuggestion(name),
      });
    const setSlug = (slug: string) => {
      setManualSlug((current) => ({ ...current, [kind]: true }));
      update({ ...value, slug });
    };
    return (
      <>
        <label>
          Name
          <input
            required
            minLength={2}
            maxLength={120}
            value={value.name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          URL slug
          <input
            required
            maxLength={160}
            pattern={slugPattern}
            value={value.slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
        <div className="catalogSlugHelp">
          <span>
            Suggested: <code>{suggestion || "Enter a name"}</code>
          </span>
          <button
            type="button"
            className="textButton"
            disabled={
              saving || !suggestion || (!touched && value.slug === suggestion)
            }
            onClick={() => {
              setManualSlug((current) => ({ ...current, [kind]: false }));
              update({ ...value, slug: suggestion });
            }}
          >
            Use suggestion
          </button>
        </div>
      </>
    );
  };
  const activeCategories = categories.filter(
    (item) => item.status === "ACTIVE",
  );
  const categoryDepth = (item: Category) => {
    let depth = 1;
    let parentId = item.parentId;
    while (parentId && depth < 4) {
      const parent = categories.find((candidate) => candidate.id === parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.parentId;
    }
    return depth;
  };
  const validParents = activeCategories.filter(
    (item) => categoryDepth(item) < 3,
  );

  return (
    <details className="catalogAddPanel">
      <summary>
        <span>
          <strong>Add to catalog</strong>
          <small>
            Create categories, brands, product types, or selectable features.
          </small>
        </span>
        <span className="catalogDisclosureHint">Show forms</span>
      </summary>
      <div className="adminCatalogForms">
        <form
          className="setting catalogCreateCard"
          onSubmit={(event) =>
            void create(
              event,
              "/api/admin/categories",
              {
                name: category.name,
                slug: category.slug,
                parentId: category.parentId || null,
                imageUrl: category.imageUrl,
              },
              "Category created.",
              () => {
                setCategory({
                  name: "",
                  slug: "",
                  parentId: "",
                  imageUrl: null,
                });
                setManualSlug((current) => ({ ...current, category: false }));
              },
            )
          }
        >
          <h3>Add category</h3>
          <div
            className="catalogCreatePreview"
            aria-label={
              category.name
                ? `Category label preview: ${category.name}`
                : "Category label preview"
            }
          >
            <span>{catalogInitials(category.name || "Category")}</span>
            <strong>{category.name || "Category label preview"}</strong>
          </div>
          {createSlugField("category", category, (next) =>
            setCategory((current) => ({ ...current, ...next })),
          )}
          <label>
            Parent category
            <select
              value={category.parentId}
              onChange={(event) =>
                setCategory((current) => ({
                  ...current,
                  parentId: event.target.value,
                }))
              }
            >
              <option value="">Top-level category</option>
              {validParents.map((item) => (
                <option key={item.id} value={item.id}>
                  {categoryLabel(item)}
                </option>
              ))}
            </select>
            <small>
              Maximum depth: main category, child, optional subcategory.
            </small>
          </label>
          <CatalogImageField
            label="Category image"
            value={category.imageUrl}
            onChange={(imageUrl) =>
              setCategory((current) => ({ ...current, imageUrl }))
            }
          />
          <button className="primary" disabled={saving || !category.slug}>
            Create category
          </button>
        </form>

        <form
          className="setting catalogCreateCard"
          onSubmit={(event) =>
            void create(
              event,
              "/api/admin/brands",
              { ...brand },
              "Brand created.",
              () => {
                setBrand({ name: "", slug: "", imageUrl: null });
                setManualSlug((current) => ({ ...current, brand: false }));
              },
            )
          }
        >
          <h3>Add brand</h3>
          <div
            className="catalogCreatePreview"
            aria-label={
              brand.name
                ? `Brand label preview: ${brand.name}`
                : "Brand label preview"
            }
          >
            <span>{catalogInitials(brand.name || "Brand")}</span>
            <strong>{brand.name || "Brand label preview"}</strong>
          </div>
          {createSlugField("brand", brand, (next) =>
            setBrand((current) => ({ ...current, ...next })),
          )}
          <p className="muted">
            Brands are marketplace-wide, not tied to a single category. Leaving
            the brand blank on a product remains supported.
          </p>
          <CatalogImageField
            label="Brand image"
            value={brand.imageUrl}
            onChange={(imageUrl) =>
              setBrand((current) => ({ ...current, imageUrl }))
            }
          />
          <button className="primary" disabled={saving || !brand.slug}>
            Create brand
          </button>
        </form>

        <form
          className="setting catalogCreateCard"
          onSubmit={(event) =>
            void create(
              event,
              "/api/admin/catalog/product-types",
              { ...productType, description: productType.description || null },
              "Product type created.",
              () => {
                setProductType({
                  name: "",
                  slug: "",
                  description: "",
                  requiresShipping: true,
                  displayOrder: productTypes.length * 10,
                });
                setManualSlug((current) => ({
                  ...current,
                  productType: false,
                }));
              },
            )
          }
        >
          <h3>Add product type</h3>
          {createSlugField("productType", productType, (next) =>
            setProductType((current) => ({ ...current, ...next })),
          )}
          <label>
            Description
            <input
              maxLength={500}
              value={productType.description}
              onChange={(event) =>
                setProductType((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Display order
            <input
              type="number"
              min="0"
              max="100000"
              value={productType.displayOrder}
              onChange={(event) =>
                setProductType((current) => ({
                  ...current,
                  displayOrder: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="adminCatalogCheckbox">
            <input
              type="checkbox"
              checked={productType.requiresShipping}
              onChange={(event) =>
                setProductType((current) => ({
                  ...current,
                  requiresShipping: event.target.checked,
                }))
              }
            />
            Requires shipping
          </label>
          <button className="primary" disabled={saving || !productType.slug}>
            Create product type
          </button>
        </form>

        <form
          className="setting catalogCreateCard"
          onSubmit={(event) =>
            void create(
              event,
              "/api/admin/catalog/features",
              {
                name: feature.name,
                categoryId: feature.categoryId || null,
                productTypeId: feature.productTypeId || null,
              },
              "Product feature created.",
              () => setFeature({ name: "", categoryId: "", productTypeId: "" }),
            )
          }
        >
          <h3>Add feature</h3>
          <label>
            Name
            <input
              required
              minLength={2}
              maxLength={120}
              value={feature.name}
              onChange={(event) =>
                setFeature((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Product type scope
            <select
              value={feature.productTypeId}
              onChange={(event) =>
                setFeature((current) => ({
                  ...current,
                  productTypeId: event.target.value,
                }))
              }
            >
              <option value="">All product types</option>
              {productTypes
                .filter((item) => item.status === "ACTIVE")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Category scope
            <select
              value={feature.categoryId}
              onChange={(event) =>
                setFeature((current) => ({
                  ...current,
                  categoryId: event.target.value,
                }))
              }
            >
              <option value="">All categories</option>
              {activeCategories.map((item) => (
                <option key={item.id} value={item.id}>
                  {categoryLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={saving}>
            Create feature
          </button>
        </form>
      </div>
    </details>
  );
}
