import React, { useEffect, useRef, useState } from "react";
import {
  type CatalogBrand,
  type CatalogCategory,
  type CatalogProductType,
} from "./CatalogFields.js";
import { SellerDiscounts } from "./SellerDiscounts.js";
import { ProductManagement } from "./SellerProductList.js";
import {
  SellerProductMediaLibrary,
  useSellerProductMedia,
} from "./SellerProductMediaLibrary.js";

type SellerProductsData = {
  products: any[];
  store: { baseCurrency?: string | null };
};

type DashboardRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
import {
  SellerProductCreateForm,
  type SellerProductFormState,
} from "./SellerProductCreateForm.js";
import {
  normalizeColorVariantName,
  type SellerColorVariantDraft,
} from "./SellerColorVariantFields.js";

export function SellerProducts({
  data,
  reload,
  request,
}: {
  data: SellerProductsData;
  reload: () => void;
  request: DashboardRequest;
}) {
  const [form, setForm] = useState<SellerProductFormState>({
    name: "",
    description: "",
    priceMinor: 1000,
    salePriceMinor: "",
    stock: 1,
    categoryId: null as string | null,
    brandId: null as string | null,
    productTypeId: "",
    featureIds: [] as string[],
    wholesaleEnabled: false,
    wholesaleMinQuantity: "2",
    wholesaleMaxQuantity: "99",
  });
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [productTypes, setProductTypes] = useState<CatalogProductType[]>([]);
  const [message, setMessage] = useState("");
  const [resourceErrors, setResourceErrors] = useState({ taxonomy: "" });
  const [resourceRetry, setResourceRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [variantDrafts, setVariantDrafts] = useState<SellerColorVariantDraft[]>([]);
  const [pendingProductId, setPendingProductId] = useState("");
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);
  const createLock = useRef(false);
  const productMedia = useSellerProductMedia({ request, reload, setMessage });
  const {
    media,
    uploading,
    uploadProgress,
    uploadFiles,
  } = productMedia;
  const approvedImages = media
    .filter((asset) =>
      asset.kind === "IMAGE" &&
      asset.uploadStatus === "COMPLETE" &&
      asset.scanStatus === "APPROVED",
    )
    .map(({ id, originalName }) => ({ id, originalName }));
  useEffect(() => {
    let active = true;
    setTaxonomyLoading(true);
    setResourceErrors({ taxonomy: "" });
    const loadTaxonomy = async () => {
      try {
        const taxonomy = await request<{
          categories: CatalogCategory[];
          brands: CatalogBrand[];
          productTypes: CatalogProductType[];
        }>("/api/catalog/taxonomy");
        if (!active) return;
        setCategories(taxonomy.categories);
        setBrands(taxonomy.brands);
        setProductTypes(taxonomy.productTypes);
        setForm((current) => ({
          ...current,
          productTypeId:
            current.productTypeId || taxonomy.productTypes[0]?.id || "",
        }));
      } catch (error) {
        if (!active) return;
        const message = (error as Error).message;
        setResourceErrors({ taxonomy: message });
        setMessage(`Catalog options: ${message}`);
      } finally {
        if (active) setTaxonomyLoading(false);
      }
    };
    void loadTaxonomy();
    return () => {
      active = false;
    };
  }, [resourceRetry, request]);
  const resetCreateForm = () => {
    setForm({
      name: "",
      description: "",
      priceMinor: 1000,
      salePriceMinor: "",
      stock: 1,
      categoryId: null,
      brandId: null,
      productTypeId: productTypes[0]?.id ?? "",
      featureIds: [],
      wholesaleEnabled: false,
      wholesaleMinQuantity: "2",
      wholesaleMaxQuantity: "99",
    });
    setVariantDrafts([]);
    setPendingProductId("");
  };

  const saveColorVariants = async (
    productId: string,
    drafts: SellerColorVariantDraft[],
  ) => {
    const failedNames: string[] = [];
    let savedCount = 0;
    for (const variant of drafts) {
      if (variant.status === "saved") {
        savedCount += 1;
        continue;
      }
      setVariantDrafts((current) => current.map((item) =>
        item.key === variant.key ? { ...item, status: "saving", error: undefined } : item,
      ));
      try {
        await request(`/api/products/${encodeURIComponent(productId)}/variants`, {
          method: "POST",
          body: JSON.stringify({
            name: variant.name.trim(),
            sku: variant.sku.trim(),
            priceMinor: Number(variant.priceMinor),
            stock: Number(variant.stock),
            mediaAssetId: variant.mediaAssetId || null,
          }),
        });
        savedCount += 1;
        setVariantDrafts((current) => current.map((item) =>
          item.key === variant.key ? { ...item, status: "saved", error: undefined } : item,
        ));
      } catch (error) {
        const message = (error as Error).message;
        failedNames.push(`${variant.name}: ${message}`);
        setVariantDrafts((current) => current.map((item) =>
          item.key === variant.key ? { ...item, status: "failed", error: message } : item,
        ));
      }
    }
    await reload();
    if (failedNames.length) {
      setMessage(`Product saved; ${savedCount} color option(s) saved. Retry the failed option(s): ${failedNames.join("; ")}`);
      return false;
    }
    resetCreateForm();
    setMessage("Listing and all color options saved through the configured product review policy.");
    return true;
  };

  const createListing = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createLock.current) return;
    const priceMinor = Number(form.priceMinor);
    const salePriceMinor = form.salePriceMinor === "" ? null : Number(form.salePriceMinor);
    const stock = Number(form.stock);
    if (
      !Number.isSafeInteger(priceMinor) || priceMinor < 1 ||
      (salePriceMinor !== null && (!Number.isSafeInteger(salePriceMinor) || salePriceMinor < 1 || salePriceMinor >= priceMinor)) ||
      !Number.isSafeInteger(stock) || stock < 0
    ) {
      setMessage("Check the regular price, lower sale price, and available stock.");
      return;
    }
    const wholesaleMinQuantity = form.wholesaleEnabled ? Number(form.wholesaleMinQuantity) : null;
    const wholesaleMaxQuantity = form.wholesaleEnabled ? Number(form.wholesaleMaxQuantity) : null;
    if (form.wholesaleEnabled && (!Number.isInteger(wholesaleMinQuantity) || !Number.isInteger(wholesaleMaxQuantity) || wholesaleMinQuantity! < 1 || wholesaleMinQuantity! > wholesaleMaxQuantity! || wholesaleMaxQuantity! > 99)) {
      setMessage("For wholesale listings, enter a minimum of 1 or more and a maximum at least as high as the minimum (up to 99).");
      return;
    }
    if (!pendingProductId && (taxonomyLoading || !productTypes.length)) {
      setMessage("Approved product types are still loading or unavailable. Try again shortly.");
      return;
    }
    const names = new Set<string>();
    const skus = new Set<string>();
    for (const variant of variantDrafts) {
      const name = normalizeColorVariantName(variant.name);
      const sku = variant.sku.trim().toLocaleUpperCase();
      const variantPrice = Number(variant.priceMinor);
      const variantStock = Number(variant.stock);
      if (!name || !sku || sku.length < 2 || sku.length > 80 || !Number.isSafeInteger(variantPrice) || variantPrice < 1 || !Number.isSafeInteger(variantStock) || variantStock < 0) {
        setMessage(`Complete the color name, unique SKU, positive price, and non-negative stock for ${variant.name || "each color option"}.`);
        return;
      }
      if (names.has(name) || skus.has(sku)) {
        setMessage("Color names and SKUs must be unique within this listing.");
        return;
      }
      names.add(name);
      skus.add(sku);
    }
    createLock.current = true;
    setCreating(true);
    setMessage("");
    try {
      let productId = pendingProductId;
      if (!productId) {
        const product = await request<{ id: string }>("/api/products", {
          method: "POST",
          body: JSON.stringify({
            ...form,
            priceMinor,
            salePriceMinor,
            stock,
            wholesaleMinQuantity,
            wholesaleMaxQuantity,
          }),
        });
        if (!product.id) throw new Error("The product was saved but its identifier was not returned. Refresh Your listings before retrying.");
        productId = product.id;
        setPendingProductId(productId);
        await reload();
      }
      if (!variantDrafts.length) {
        resetCreateForm();
        setMessage("Listing created and sent through the configured product review policy.");
        await reload();
      } else {
        await saveColorVariants(productId, variantDrafts);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  };
  return (
    <section className="sellerProducts">
      <header className="sellerProductsHeader">
        <div>
          <p className="eyebrow">Catalog management</p>
          <h2>Products</h2>
          <p className="muted">
            Create, organize, price, and maintain your Store listings.
          </p>
        </div>
        <div className="sellerListingMetrics" aria-label="Listing summary">
          <span>
            <strong>{data.products.length}</strong> listings
          </span>
          <span>
            <strong>
              {
                data.products.filter((product) => product.status === "APPROVED")
                  .length
              }
            </strong>{" "}
            live
          </span>
          <span>
            <strong>
              {
                data.products.filter((product) => product.status === "PENDING")
                  .length
              }
            </strong>{" "}
            under review
          </span>
        </div>
      </header>
      {message && (
        <p
          className="notice sellerProductNotice"
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      )}
      <SellerProductCreateForm
        form={form}
        setForm={setForm}
        currency={data.store.baseCurrency ?? "USD"}
        taxonomyLoading={taxonomyLoading}
        taxonomyError={resourceErrors.taxonomy}
        onRetry={() => setResourceRetry((value) => value + 1)}
        categories={categories}
        brands={brands}
        productTypes={productTypes}
        creating={creating}
        productSaved={Boolean(pendingProductId)}
        variantDrafts={variantDrafts}
        setVariantDrafts={setVariantDrafts}
        approvedImages={approvedImages}
        onSubmit={(event) => void createListing(event)}
        setMessage={setMessage}
      />{" "}
      <SellerProductMediaLibrary {...productMedia} />
      <section
        className="sellerProductModule sellerListingsModule"
        aria-labelledby="your-listings-heading"
      >
        <header className="sellerSectionHeading">
          <span className="sellerStep">03</span>
          <div>
            <p className="eyebrow">Inventory</p>
            <h3 id="your-listings-heading">Your listings</h3>
            <p className="muted">
              Update product details, inventory, and approved gallery media.
            </p>
          </div>
        </header>
        <ProductManagement
          products={data.products}
          media={media}
          categories={categories}
          brands={brands}
          productTypes={productTypes}
          reload={reload}
          setMessage={setMessage}
          onUploadFiles={uploadFiles}
          uploading={uploading}
          uploadProgress={uploadProgress}
          request={request}
        />
        {data.products.length === 0 && (
          <div className="empty">
            No products yet. Create your first listing above.
          </div>
        )}
      </section>
      <SellerDiscounts
        products={data.products}
        categories={categories}
        currency={data.store.baseCurrency ?? "USD"}
      />
    </section>
  );
}
