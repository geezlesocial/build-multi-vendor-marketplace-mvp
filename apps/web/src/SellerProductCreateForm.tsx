import React, {
  type Dispatch,
  type FormEventHandler,
  type SetStateAction,
} from "react";
import {
  CatalogFields,
  type CatalogBrand,
  type CatalogCategory,
  type CatalogProductType,
} from "./CatalogFields.js";
import {
  SellerColorVariantFields,
  type ApprovedColorImage,
  type SellerColorVariantDraft,
} from "./SellerColorVariantFields.js";

export type SellerProductFormState = {
  name: string;
  description: string;
  priceMinor: number;
  salePriceMinor: string;
  stock: number;
  categoryId: string | null;
  brandId: string | null;
  productTypeId: string;
  featureIds: string[];
  wholesaleEnabled: boolean;
  wholesaleMinQuantity: string;
  wholesaleMaxQuantity: string;
};

type SellerProductCreateFormProps = {
  form: SellerProductFormState;
  setForm: Dispatch<SetStateAction<SellerProductFormState>>;
  currency: string;
  taxonomyLoading: boolean;
  taxonomyError: string;
  onRetry: () => void;
  categories: CatalogCategory[];
  brands: CatalogBrand[];
  productTypes: CatalogProductType[];
  creating: boolean;
  productSaved: boolean;
  variantDrafts: SellerColorVariantDraft[];
  setVariantDrafts: Dispatch<SetStateAction<SellerColorVariantDraft[]>>;
  approvedImages: ApprovedColorImage[];
  onSubmit: FormEventHandler<HTMLFormElement>;
  setMessage: (value: string) => void;
};

export function SellerProductCreateForm({
  form,
  setForm,
  currency,
  taxonomyLoading,
  taxonomyError,
  onRetry,
  categories,
  brands,
  productTypes,
  creating,
  productSaved,
  variantDrafts,
  setVariantDrafts,
  approvedImages,
  onSubmit,
  setMessage,
}: SellerProductCreateFormProps) {
  return (
    <section
      className="setting sellerProductModule"
      aria-labelledby="create-listing-heading"
    >
      <header className="sellerSectionHeading">
        <span className="sellerStep">01</span>
        <div>
          <p className="eyebrow">New listing</p>
          <h3 id="create-listing-heading">Create a product</h3>
          <p className="muted">
            Set the core details, then add any color options and approved color images.
          </p>
        </div>
      </header>
      {taxonomyLoading && (
        <p className="muted" role="status" aria-busy="true">
          Loading approved catalog options…
        </p>
      )}
      {taxonomyError && (
        <p className="notice" role="alert">
          Catalog options could not be loaded: {taxonomyError}{" "}
          <button type="button" onClick={() => onRetry()}>
            Retry
          </button>
        </p>
      )}
      {productSaved && (
        <p className="notice" role="status">
          The product is saved. Color options are being saved separately; retrying will continue this listing and will not create another product.
        </p>
      )}
      <form className="sellerProductCreate" onSubmit={onSubmit}>
        <fieldset className="sellerProductCoreFields" disabled={productSaved}>
          <div className="sellerProductCoreGrid">
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
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="sellerPriceFields">
              <label>
                Regular price ({currency} minor units)
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={form.priceMinor}
                  onChange={(event) => setForm({ ...form, priceMinor: Number(event.target.value) })}
                />
              </label>
              <label>
                Sale price (optional)
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, Number(form.priceMinor) - 1)}
                  step="1"
                  value={form.salePriceMinor}
                  onChange={(event) => setForm({ ...form, salePriceMinor: event.target.value })}
                />
              </label>
              <label>
                Available stock
                <input
                  required
                  type="number"
                  min="0"
                  step="1"
                  value={form.stock}
                  onChange={(event) => setForm({ ...form, stock: Number(event.target.value) })}
                />
              </label>
            </div>
            <fieldset className="wholesaleFields">
              <legend>Wholesale order settings</legend>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={form.wholesaleEnabled}
                  onChange={(event) => setForm({ ...form, wholesaleEnabled: event.target.checked })}
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
                      onChange={(event) => setForm({ ...form, wholesaleMinQuantity: event.target.value })}
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
                      onChange={(event) => setForm({ ...form, wholesaleMaxQuantity: event.target.value })}
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
              featureIds={form.featureIds}
              onCategoryChange={(categoryId) => setForm((current) => ({ ...current, categoryId }))}
              onBrandChange={(brandId) => setForm((current) => ({ ...current, brandId }))}
              onProductTypeChange={(productTypeId) => setForm((current) => ({ ...current, productTypeId }))}
              onFeatureIdsChange={(featureIds) => setForm((current) => ({ ...current, featureIds }))}
              onMessage={setMessage}
            />
          </div>
        </fieldset>
        <SellerColorVariantFields
          variants={variantDrafts}
          onChange={setVariantDrafts}
          approvedImages={approvedImages}
          defaultPriceMinor={form.priceMinor}
          defaultStock={form.stock}
          disabled={creating}
        />
        <button
          className="primary"
          disabled={creating || (taxonomyLoading && !productSaved) || (!productTypes.length && !productSaved)}
        >
          {creating
            ? productSaved ? "Saving color options…" : "Saving listing and colors…"
            : productSaved ? "Retry unsaved color options" : "Create listing"}
        </button>
      </form>
    </section>
  );
}
