import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CatalogImageField } from "./CatalogImageField.js";
import {
  catalogSlugSuggestion,
  type Brand,
  type CatalogEntity,
  type Category,
  type EditValues,
  type EntityKind,
  type Feature,
  type ProductType,
} from "./admin-catalog-helpers.js";

type Editing = { kind: EntityKind; item: CatalogEntity };
const statuses = ["ACTIVE", "INACTIVE", "ARCHIVED"];

function initialValues(kind: EntityKind, item: CatalogEntity): EditValues {
  const values: EditValues = {
    name: item.name,
    slug: item.slug,
    status: item.status,
    displayOrder: "displayOrder" in item ? item.displayOrder : 0,
  };
  if (kind === "category") {
    const category = item as Category;
    return {
      ...values,
      description: category.description ?? "",
      parentId: category.parentId ?? "",
      imageUrl: category.imageUrl ?? null,
    };
  }
  if (kind === "brand") {
    const brand = item as Brand;
    return {
      ...values,
      description: brand.description ?? "",
      imageUrl: brand.imageUrl ?? null,
    };
  }
  if (kind === "productType") {
    const type = item as ProductType;
    return {
      ...values,
      description: type.description ?? "",
      requiresShipping: type.requiresShipping,
    };
  }
  const feature = item as Feature;
  return {
    ...values,
    categoryId: feature.categoryId ?? "",
    productTypeId: feature.productTypeId ?? "",
  };
}

export function AdminCatalogEditor({
  editing,
  categories,
  productTypes,
  onClose,
  onSave,
}: {
  editing: Editing | null;
  categories: Category[];
  productTypes: ProductType[];
  onClose: () => void;
  onSave: (
    kind: EntityKind,
    id: string,
    values: EditValues,
  ) => Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [values, setValues] = useState<EditValues>({});
  const [original, setOriginal] = useState<EditValues>({});
  const [saving, setSaving] = useState(false);
  const key = editing ? `${editing.kind}:${editing.item.id}` : "";
  const dirty = JSON.stringify(values) !== JSON.stringify(original);

  useEffect(() => {
    const current = editingRef.current;
    if (!current) return;
    const next = initialValues(current.kind, current.item);
    setValues(next);
    setOriginal(next);
    setSaving(false);
  }, [key]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (key && !dialog.open) dialog.showModal();
    if (!key && dialog.open) dialog.close();
  }, [key]);

  const requestClose = () => {
    if (dirty && !window.confirm("Discard the unsaved catalog changes?"))
      return;
    onClose();
  };
  const update = (field: string, value: string | number | boolean | null) =>
    setValues((current) => ({ ...current, [field]: value }));
  const categoryDepth = (category: Category) => {
    let depth = 1;
    let parentId = category.parentId;
    while (parentId && depth < 4) {
      const parent = categories.find((item) => item.id === parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.parentId;
    }
    return depth;
  };
  const categoryPath = (category: Category) => {
    const names = [category.name];
    let parentId = category.parentId;
    while (parentId) {
      const parent = categories.find((item) => item.id === parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return names.join(" / ");
  };
  const childrenByParent = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const category of categories)
      if (category.parentId)
        result.set(category.parentId, [
          ...(result.get(category.parentId) ?? []),
          category.id,
        ]);
    return result;
  }, [categories]);
  const excludedParents = useMemo(() => {
    if (editing?.kind !== "category") return new Set<string>();
    const excluded = new Set([editing.item.id]);
    const pending = [editing.item.id];
    while (pending.length)
      for (const child of childrenByParent.get(pending.pop()!) ?? []) {
        if (!excluded.has(child)) {
          excluded.add(child);
          pending.push(child);
        }
      }
    return excluded;
  }, [childrenByParent, editing]);
  const validParents = categories.filter(
    (category) =>
      category.status === "ACTIVE" &&
      !excludedParents.has(category.id) &&
      categoryDepth(category) < 3,
  );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !dirty || saving) return;
    setSaving(true);
    const ok = await onSave(editing.kind, editing.item.id, values);
    setSaving(false);
    if (ok) onClose();
  };
  const slugProposal =
    editing &&
    ["category", "brand", "productType"].includes(editing.kind) &&
    values.name !== original.name
      ? catalogSlugSuggestion(String(values.name ?? ""))
      : "";
  const body = (
    field: string,
    label: string,
    options: {
      type?: string;
      min?: number;
      max?: number;
      maxLength?: number;
    } = {},
  ) => (
    <label className="catalogEditorField" key={field}>
      {label}
      <input
        type={options.type ?? "text"}
        value={String(values[field] ?? "")}
        min={options.min}
        max={options.max}
        maxLength={options.maxLength}
        onChange={(event) =>
          update(
            field,
            options.type === "number"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  );

  return (
    <dialog
      ref={dialogRef}
      className="catalogEditorDialog"
      aria-labelledby="catalogEditorTitle"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
    >
      {editing && (
        <form
          className="catalogEditorForm"
          onSubmit={(event) => void save(event)}
        >
          <header className="catalogEditorHeader">
            <div>
              <p className="eyebrow">Catalog record · {editing.item.status}</p>
              <h2 id="catalogEditorTitle">
                Edit{" "}
                {editing.kind === "productType" ? "product type" : editing.kind}
                : {editing.item.name}
              </h2>
            </div>
            <button
              type="button"
              className="catalogIconButton"
              aria-label="Close editor"
              disabled={saving}
              onClick={requestClose}
            >
              ×
            </button>
          </header>
          <div className="catalogEditorBody">
            {body("name", "Name", { maxLength: 120 })}
            {editing.kind !== "feature" && (
              <>
                {body("slug", "URL slug", { maxLength: 160 })}
                {slugProposal && slugProposal !== values.slug && (
                  <div className="catalogSlugProposal">
                    <span>
                      Suggested from the new name: <code>{slugProposal}</code>.
                      The saved URL is unchanged until you apply a suggestion.
                    </span>
                    <button
                      type="button"
                      onClick={() => update("slug", slugProposal)}
                    >
                      Apply suggestion
                    </button>
                  </div>
                )}
                {editing.kind === "category" &&
                  values.slug !== original.slug && (
                    <p className="catalogEditorWarning">
                      Applying a new category slug creates a permanent redirect
                      from the previous public category URL.
                    </p>
                  )}
                {body("description", "Description", { maxLength: 500 })}
              </>
            )}
            {editing.kind === "category" && (
              <>
                <label className="catalogEditorField">
                  Parent category
                  <select
                    value={String(values.parentId ?? "")}
                    onChange={(event) => update("parentId", event.target.value)}
                  >
                    <option value="">Top-level category</option>
                    {validParents.map((category) => (
                      <option key={category.id} value={category.id}>
                        {categoryPath(category)}
                      </option>
                    ))}
                  </select>
                  <small>
                    Three levels maximum. A proposed move that would deepen
                    existing descendants is rejected.
                  </small>
                </label>
                {body("displayOrder", "Display order", {
                  type: "number",
                  min: 0,
                  max: 100000,
                })}
                <CatalogImageField
                  label="Category image"
                  value={String(values.imageUrl ?? "") || null}
                  originalValue={String(original.imageUrl ?? "") || null}
                  onChange={(value) => update("imageUrl", value)}
                  disabled={saving}
                />
              </>
            )}
            {editing.kind === "brand" && (
              <>
                {body("displayOrder", "Display order", {
                  type: "number",
                  min: 0,
                  max: 100000,
                })}
                <CatalogImageField
                  label="Brand image"
                  value={String(values.imageUrl ?? "") || null}
                  originalValue={String(original.imageUrl ?? "") || null}
                  onChange={(value) => update("imageUrl", value)}
                  disabled={saving}
                />
              </>
            )}
            {editing.kind === "productType" && (
              <>
                {body("displayOrder", "Display order", {
                  type: "number",
                  min: 0,
                  max: 100000,
                })}
                <label className="adminCatalogCheckbox">
                  <input
                    type="checkbox"
                    checked={Boolean(values.requiresShipping)}
                    onChange={(event) =>
                      update("requiresShipping", event.target.checked)
                    }
                  />
                  Requires shipping
                </label>
              </>
            )}
            {editing.kind === "feature" && (
              <>
                <label className="catalogEditorField">
                  Product type scope
                  <select
                    value={String(values.productTypeId ?? "")}
                    onChange={(event) =>
                      update("productTypeId", event.target.value)
                    }
                  >
                    <option value="">All product types</option>
                    {productTypes
                      .filter((type) => type.status === "ACTIVE")
                      .map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="catalogEditorField">
                  Category scope
                  <select
                    value={String(values.categoryId ?? "")}
                    onChange={(event) =>
                      update("categoryId", event.target.value)
                    }
                  >
                    <option value="">All categories</option>
                    {categories
                      .filter((category) => category.status === "ACTIVE")
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {categoryPath(category)}
                        </option>
                      ))}
                  </select>
                </label>
                {body("displayOrder", "Display order", {
                  type: "number",
                  min: 0,
                  max: 100000,
                })}
              </>
            )}
            <label className="catalogEditorField">
              Status
              <select
                value={String(values.status ?? "ACTIVE")}
                onChange={(event) => update("status", event.target.value)}
              >
                {statuses.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
          <footer className="catalogEditorFooter">
            <button type="button" disabled={saving} onClick={requestClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!dirty || saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
