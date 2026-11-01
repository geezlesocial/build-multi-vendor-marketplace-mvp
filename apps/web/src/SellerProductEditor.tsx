import React, { useEffect, useRef, useState } from "react";
import {
  PRODUCT_MEDIA_ACCEPT,
  PRODUCT_MEDIA_LIMITS,
  productMediaCounts,
} from "./media-upload.js";
import {
  CatalogFields,
  type CatalogBrand,
  type CatalogCategory,
  type CatalogProductType,
} from "./CatalogFields.js";
import "./ProductManagement.css";

type DashboardRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export function ProductEditor({
  product,
  approvedMedia,
  categories,
  brands,
  productTypes,
  reload,
  setMessage,
  onUploadFiles,
  uploading,
  uploadProgress,
  request,
}: {
  product: any;
  approvedMedia: any[];
  categories: CatalogCategory[];
  brands: CatalogBrand[];
  productTypes: CatalogProductType[];
  reload: () => void;
  setMessage: (value: string) => void;
  onUploadFiles: (files: File[], product?: any) => void;
  uploading: boolean;
  uploadProgress: number | null;
  request: DashboardRequest;
}) {
  const [form, setForm] = useState({
    name: product.name,
    description: product.description,
    priceMinor: String(product.priceMinor),
    salePriceMinor:
      product.salePriceMinor == null ? "" : String(product.salePriceMinor),
    stock: String(product.inventory?.quantity ?? 0),
    categoryId: product.categoryId ?? (null as string | null),
    brandId: product.brandId ?? (null as string | null),
    productTypeId: product.productTypeId ?? "",
    color: product.color ?? "",
    featureIds: (product.featureAssignments ?? []).map(
      (item: any) => item.featureId,
    ) as string[],
    wholesaleEnabled: Boolean(product.wholesaleEnabled),
    wholesaleMinQuantity:
      product.wholesaleMinQuantity == null
        ? "2"
        : String(product.wholesaleMinQuantity),
    wholesaleMaxQuantity:
      product.wholesaleMaxQuantity == null
        ? "99"
        : String(product.wholesaleMaxQuantity),
  });
  const [selectedMedia, setSelectedMedia] = useState("");
  const [saving, setSaving] = useState(false);
  const actionLock = useRef(false);
  useEffect(
    () =>
      setForm({
        name: product.name,
        description: product.description,
        priceMinor: String(product.priceMinor),
        salePriceMinor:
          product.salePriceMinor == null ? "" : String(product.salePriceMinor),
        stock: String(product.inventory?.quantity ?? 0),
        categoryId: product.categoryId ?? null,
        brandId: product.brandId ?? null,
        productTypeId: product.productTypeId ?? "",
        color: product.color ?? "",
        featureIds: (product.featureAssignments ?? []).map(
          (item: any) => item.featureId,
        ),
        wholesaleEnabled: Boolean(product.wholesaleEnabled),
        wholesaleMinQuantity:
          product.wholesaleMinQuantity == null
            ? "2"
            : String(product.wholesaleMinQuantity),
        wholesaleMaxQuantity:
          product.wholesaleMaxQuantity == null
            ? "99"
            : String(product.wholesaleMaxQuantity),
      }),
    [product],
  );
  const runProductAction = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> => {
    if (actionLock.current) return false;
    actionLock.current = true;
    setSaving(true);
    setMessage("");
    try {
      await action();
      setMessage(successMessage);
      await reload();
      return true;
    } catch (error) {
      setMessage((error as Error).message);
      return false;
    } finally {
      actionLock.current = false;
      setSaving(false);
    }
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wholesaleMinQuantity = form.wholesaleEnabled
      ? Number(form.wholesaleMinQuantity)
      : null;
    const wholesaleMaxQuantity = form.wholesaleEnabled
      ? Number(form.wholesaleMaxQuantity)
      : null;
    if (
      form.wholesaleEnabled &&
      (!Number.isInteger(wholesaleMinQuantity) ||
        !Number.isInteger(wholesaleMaxQuantity) ||
        wholesaleMinQuantity! < 1 ||
        wholesaleMinQuantity! > wholesaleMaxQuantity! ||
        wholesaleMaxQuantity! > 99)
    ) {
      setMessage(
        "For wholesale listings, enter a minimum of 1 or more and a maximum at least as high as the minimum (up to 99).",
      );
      return;
    }
    await runProductAction(
      () =>
        request(`/api/products/${encodeURIComponent(product.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: form.name,
            description: form.description,
            priceMinor: Number(form.priceMinor),
            salePriceMinor:
              form.salePriceMinor === "" ? null : Number(form.salePriceMinor),
            stock: Number(form.stock),
            categoryId: form.categoryId,
            brandId: form.brandId,
            productTypeId: form.productTypeId,
            color: form.color || null,
            featureIds: form.featureIds,
            wholesaleEnabled: form.wholesaleEnabled,
            wholesaleMinQuantity,
            wholesaleMaxQuantity,
          }),
        }),
      "Product details saved.",
    );
  };
  const attach = async () => {
    const asset = approvedMedia.find((item) => item.id === selectedMedia);
    if (!asset) return;
    const attached = await runProductAction(
      () =>
        request(`/api/products/${encodeURIComponent(product.id)}/media`, {
          method: "POST",
          body: JSON.stringify({
            mediaAssetId: asset.id,
            label: asset.originalName.replace(/\.[^.]+$/, ""),
          }),
        }),
      "Approved media attached to the product gallery.",
    );
    if (attached) setSelectedMedia("");
  };
  const counts = productMediaCounts(product);
  return (
    <article className="setting productEditor">
      <div className="productEditorHeading">
        <div>
          <h3>{product.name}</h3>
          <small>
            {product.status} · {product.inventory?.quantity ?? 0} in stock ·{" "}
            {product.variants?.length ?? 0} variants
          </small>
        </div>
        {product.status !== "ARCHIVED" && (
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              void runProductAction(
                () =>
                  request(
                    `/api/seller/products/${encodeURIComponent(product.id)}/archive`,
                    { method: "PATCH", body: "{}" },
                  ),
                "Product archived.",
              )
            }
          >
            Archive
          </button>
        )}
      </div>
      <form onSubmit={(event) => void save(event)}>
        <label>
          Product name
          <input
            required
            minLength={2}
            maxLength={120}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            required
            minLength={2}
            maxLength={5000}
            value={form.description}
            onChange={(event) =>
              setForm({ ...form, description: event.target.value })
            }
          />
        </label>
        <div className="sellerPriceFields">
          <label>
            Regular price (minor units)
            <input
              required
              type="number"
              min="1"
              step="1"
              value={form.priceMinor}
              onChange={(event) =>
                setForm({ ...form, priceMinor: event.target.value })
              }
            />
          </label>
          <label>
            Sale price (optional; must be lower)
            <input
              type="number"
              min="1"
              step="1"
              value={form.salePriceMinor}
              onChange={(event) =>
                setForm({ ...form, salePriceMinor: event.target.value })
              }
            />
          </label>
          <label>
            Stock
            <input
              type="number"
              min="0"
              step="1"
              value={form.stock}
              onChange={(event) =>
                setForm({ ...form, stock: event.target.value })
              }
            />
          </label>
        </div>
        <fieldset className="wholesaleFields">
          <legend>Wholesale order settings</legend>
          <label className="checkRow">
            <input
              type="checkbox"
              checked={form.wholesaleEnabled}
              onChange={(event) =>
                setForm({ ...form, wholesaleEnabled: event.target.checked })
              }
            />
            List this item as wholesale
          </label>
          {form.wholesaleEnabled && (
            <div className="two">
              <label>
                Minimum units per order
                <input
                  type="number"
                  required
                  min="1"
                  max="99"
                  step="1"
                  value={form.wholesaleMinQuantity}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      wholesaleMinQuantity: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Maximum units per order
                <input
                  type="number"
                  required
                  min={Math.max(1, Number(form.wholesaleMinQuantity) || 1)}
                  max="99"
                  step="1"
                  value={form.wholesaleMaxQuantity}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      wholesaleMaxQuantity: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          )}
        </fieldset>
        <CatalogFields
          categories={categories}
          brands={brands}
          productTypes={productTypes}
          categoryId={form.categoryId}
          brandId={form.brandId}
          productTypeId={form.productTypeId}
          color={form.color}
          featureIds={form.featureIds}
          onCategoryChange={(categoryId) =>
            setForm((current) => ({ ...current, categoryId }))
          }
          onBrandChange={(brandId) =>
            setForm((current) => ({ ...current, brandId }))
          }
          onProductTypeChange={(productTypeId) =>
            setForm((current) => ({ ...current, productTypeId }))
          }
          onColorChange={(color) =>
            setForm((current) => ({ ...current, color }))
          }
          onFeatureIdsChange={(featureIds) =>
            setForm((current) => ({ ...current, featureIds }))
          }
          onMessage={setMessage}
        />
        <button disabled={saving}>{saving ? "Saving…" : "Save product"}</button>
      </form>
      <div className="productAttachments">
        <strong>Gallery and product files</strong>
        {product.images?.map((image: any) => (
          <div className="productAttachment" key={`legacy-${image.id}`}>
            <span>IMAGE · {image.alt}</span>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void runProductAction(
                  () =>
                    request(
                      `/api/products/${encodeURIComponent(product.id)}/images/${encodeURIComponent(image.id)}`,
                      { method: "DELETE" },
                    ),
                  "Gallery image removed.",
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        {product.mediaAttachments?.map((attachment: any) => (
          <div className="productAttachment" key={attachment.id}>
            <span>
              {attachment.mediaAsset.kind} ·{" "}
              {attachment.label || attachment.mediaAsset.originalName}
            </span>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void runProductAction(
                  () =>
                    request(
                      `/api/products/${encodeURIComponent(product.id)}/media/${encodeURIComponent(attachment.id)}`,
                      { method: "DELETE" },
                    ),
                  "Product media removed.",
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        {!product.images?.length && !product.mediaAttachments?.length && (
          <small>No product media attached yet.</small>
        )}
      </div>
      <div className="productMediaUploadControl">
        <label>
          Upload to this product from your device
          <input
            type="file"
            multiple
            accept={PRODUCT_MEDIA_ACCEPT}
            disabled={saving || uploading}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length) onUploadFiles(files, product);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <small>
          Images {counts.IMAGE}/{PRODUCT_MEDIA_LIMITS.IMAGE} · Video{" "}
          {counts.VIDEO}/{PRODUCT_MEDIA_LIMITS.VIDEO} · Documents/PDF{" "}
          {counts.DOCUMENT}/{PRODUCT_MEDIA_LIMITS.DOCUMENT}. Uploads are
          attached automatically after malware approval.
        </small>
        {uploading && uploadProgress !== null && (
          <progress
            value={uploadProgress}
            max="100"
            aria-label={`Upload progress for ${product.name}`}
          />
        )}
      </div>
      <div className="productAttachControl">
        <label>
          Add approved media from library
          <select
            aria-label={`Approved product media for ${product.name}`}
            value={selectedMedia}
            onChange={(event) => setSelectedMedia(event.target.value)}
          >
            <option value="">
              Select an approved image, video, or document
            </option>
            {approvedMedia.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.kind} · {asset.originalName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!selectedMedia || saving}
          onClick={() => void attach()}
        >
          Add to gallery
        </button>
      </div>
    </article>
  );
}
