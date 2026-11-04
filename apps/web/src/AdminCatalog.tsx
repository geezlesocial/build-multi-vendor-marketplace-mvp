import { useCallback, useEffect, useRef, useState } from "react";
import "./AdminCatalog.css";
import { AdminCatalogCreateForms } from "./AdminCatalogCreateForms.js";
import { AdminCatalogEditor } from "./AdminCatalogEditor.js";
import { AdminCatalogLists } from "./AdminCatalogLists.js";
import {
  catalogApi,
  type Brand,
  type CatalogEntity,
  type Category,
  type EditValues,
  type EntityKind,
  type Feature,
  type ProductType,
  type SaveAction,
  type Suggestion,
} from "./admin-catalog-helpers.js";

type Editing = { kind: EntityKind; item: CatalogEntity };
const endpoints: Record<EntityKind, string> = {
  category: "/api/admin/categories",
  brand: "/api/admin/brands",
  productType: "/api/admin/catalog/product-types",
  feature: "/api/admin/catalog/features",
};

export function AdminCatalog() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const mutationLock = useRef(false);

  const load = useCallback(async () => {
    const [
      nextCategories,
      nextBrands,
      nextFeatures,
      nextTypes,
      nextSuggestions,
    ] = await Promise.all([
      catalogApi<Category[]>("/api/admin/categories"),
      catalogApi<Brand[]>("/api/admin/brands"),
      catalogApi<Feature[]>("/api/admin/catalog/features"),
      catalogApi<ProductType[]>("/api/admin/catalog/product-types"),
      catalogApi<Suggestion[]>("/api/admin/catalog/suggestions?status=PENDING"),
    ]);
    setCategories(nextCategories);
    setBrands(nextBrands);
    setFeatures(nextFeatures);
    setProductTypes(nextTypes);
    setSuggestions(nextSuggestions);
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
  }, [load]);

  const perform: SaveAction = async (work, success) => {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setSaving(true);
    setMessage("");
    try {
      await work();
      await load();
      setMessage(success);
      return true;
    } catch (error) {
      setMessage((error as Error).message);
      return false;
    } finally {
      mutationLock.current = false;
      setSaving(false);
    }
  };

  const categoryLabel = (category: Category) => {
    const parent = categories.find((item) => item.id === category.parentId);
    return parent ? `${parent.name} / ${category.name}` : category.name;
  };
  const beginEdit = (kind: EntityKind, item: CatalogEntity) =>
    setEditing({ kind, item });

  const saveEdit = async (kind: EntityKind, id: string, values: EditValues) => {
    const original = initialSnapshot(kind, editing?.item);
    const changed: EditValues = {};
    for (const [field, value] of Object.entries(values))
      if (JSON.stringify(value) !== JSON.stringify(original[field]))
        changed[field] = value;
    if (kind === "category" && Object.hasOwn(changed, "parentId"))
      changed.parentId = changed.parentId || null;
    if (kind === "feature") {
      if (Object.hasOwn(changed, "categoryId"))
        changed.categoryId = changed.categoryId || null;
      if (Object.hasOwn(changed, "productTypeId"))
        changed.productTypeId = changed.productTypeId || null;
    }
    if (kind === "productType" && Object.hasOwn(changed, "description"))
      changed.description = changed.description || null;
    if (kind === "category" || kind === "brand") {
      if (Object.hasOwn(changed, "description"))
        changed.description = changed.description || null;
    }
    if (!Object.keys(changed).length) return true;
    return perform(
      () =>
        catalogApi(`${endpoints[kind]}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(changed),
        }),
      "Catalog changes saved.",
    );
  };

  const changeStatus = async (
    kind: EntityKind,
    item: { id: string; status: string },
    status: string,
  ) => {
    if (saving) return;
    setBusyId(item.id);
    const path =
      kind === "feature"
        ? `${endpoints.feature}/${encodeURIComponent(item.id)}/status`
        : `${endpoints[kind]}/${encodeURIComponent(item.id)}`;
    await perform(
      () =>
        catalogApi(path, { method: "PATCH", body: JSON.stringify({ status }) }),
      "Catalog status updated.",
    );
    setBusyId("");
  };

  const deleteItem = async (
    kind: EntityKind,
    item: { id: string; name: string },
  ) => {
    if (
      saving ||
      !window.confirm(
        `Delete “${item.name}”? Referenced catalog items are protected from deletion.`,
      )
    )
      return;
    setBusyId(item.id);
    await perform(
      () =>
        catalogApi(`${endpoints[kind]}/${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        }),
      `${item.name} deleted.`,
    );
    setBusyId("");
  };

  const review = async (item: Suggestion, decision: "APPROVE" | "REJECT") => {
    if (saving) return;
    const reviewNote =
      decision === "REJECT"
        ? (window.prompt("Optional review note for the submitter") ?? "")
        : "";
    setBusyId(item.id);
    await perform(
      () =>
        catalogApi(
          `/api/admin/catalog/suggestions/${encodeURIComponent(item.id)}/review`,
          {
            method: "POST",
            body: JSON.stringify({
              decision,
              ...(reviewNote ? { reviewNote } : {}),
            }),
          },
        ),
      decision === "APPROVE"
        ? "Suggestion approved and added to the active catalog."
        : "Suggestion rejected.",
    );
    setBusyId("");
  };

  const filtered = (value: string) =>
    value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const matchingSuggestions = suggestions.filter((item) =>
    filtered(
      `${item.kind} ${item.name} ${item.submittedBy.name} ${item.submittedBy.email}`,
    ),
  );

  return (
    <section className="adminCatalog">
      <header className="adminCatalogHeader">
        <div>
          <p className="eyebrow">Marketplace setup</p>
          <h2>Catalog &amp; categories</h2>
          <p className="muted">
            Manage a three-level category tree, marketplace-wide brands,
            supported product types, and optional selectable features.
          </p>
        </div>
        <div className="catalogSummary" aria-label="Catalog totals">
          <span>
            <strong>{categories.length}</strong> categories
          </span>
          <span>
            <strong>{brands.length}</strong> brands
          </span>
          <span>
            <strong>{productTypes.length}</strong> product types
          </span>
          <span>
            <strong>{features.length}</strong> features
          </span>
        </div>
      </header>
      {message && (
        <p role="status" aria-live="polite" className="notice catalogMessage">
          {message}
        </p>
      )}

      <div className="catalogToolbar">
        <label>
          Search catalog
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a category, brand, type, feature, or suggestion"
          />
        </label>
        <p className="muted">
          Brand names are starter examples only; no marketplace endorsement,
          inventory, or ownership is implied.
        </p>
      </div>
      <AdminCatalogCreateForms
        categories={categories}
        productTypes={productTypes}
        categoryLabel={categoryLabel}
        perform={perform}
        saving={saving}
      />

      <section
        className="catalogSuggestions"
        aria-labelledby="catalogSuggestionsTitle"
      >
        <div className="catalogSectionHeading">
          <div>
            <p className="eyebrow">Review queue</p>
            <h3 id="catalogSuggestionsTitle">
              Pending catalog suggestions{" "}
              <span className="catalogCount">{suggestions.length}</span>
            </h3>
          </div>
        </div>
        {matchingSuggestions.length ? (
          <div className="catalogSuggestionList">
            {matchingSuggestions.map((item) => (
              <article className="catalogSuggestion" key={item.id}>
                <div>
                  <span className="catalogStatus catalogStatus--pending">
                    {item.kind.replaceAll("_", " ").toLowerCase()}
                  </span>
                  <strong>{item.name}</strong>
                  <p className="muted">
                    {item.kind === "CHILD_CATEGORY"
                      ? `Under ${item.parentCategory?.name ?? "missing parent"}`
                      : item.kind === "FEATURE"
                        ? `For ${item.featureCategory?.name ?? "all categories"}`
                        : "Marketplace-wide"}{" "}
                    · Suggested by{" "}
                    {item.submittedBy.name || item.submittedBy.email} ·{" "}
                    {new Date(item.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="catalogRowActions">
                  <button
                    type="button"
                    disabled={saving || busyId === item.id}
                    onClick={() => void review(item, "APPROVE")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="catalogDangerAction"
                    disabled={saving || busyId === item.id}
                    onClick={() => void review(item, "REJECT")}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty catalogEmpty">
            {suggestions.length
              ? "No pending suggestions match this search."
              : "No catalog suggestions are waiting for review."}
          </p>
        )}
      </section>

      <AdminCatalogLists
        categories={categories}
        brands={brands}
        productTypes={productTypes}
        features={features}
        search={search}
        busyId={busyId}
        onEdit={(kind, item) => beginEdit(kind, item)}
        onStatus={(kind, item, status) => void changeStatus(kind, item, status)}
        onDelete={(kind, item) => void deleteItem(kind, item)}
      />
      <AdminCatalogEditor
        editing={editing}
        categories={categories}
        productTypes={productTypes}
        onClose={() => setEditing(null)}
        onSave={saveEdit}
      />
    </section>
  );
}

function initialSnapshot(
  kind: EntityKind,
  item: CatalogEntity | undefined,
): EditValues {
  if (!item) return {};
  const values: EditValues = {
    name: item.name,
    slug: item.slug,
    status: item.status,
  };
  if ("displayOrder" in item) values.displayOrder = item.displayOrder;
  if (kind === "category" || kind === "brand") {
    if ("description" in item) values.description = item.description ?? "";
    if ("imageUrl" in item) values.imageUrl = item.imageUrl ?? null;
  }
  if (kind === "category") values.parentId = (item as Category).parentId ?? "";
  if (kind === "productType") {
    values.description = (item as ProductType).description ?? "";
    values.requiresShipping = (item as ProductType).requiresShipping;
  }
  if (kind === "feature") {
    values.categoryId = (item as Feature).categoryId ?? "";
    values.productTypeId = (item as Feature).productTypeId ?? "";
  }
  return values;
}
