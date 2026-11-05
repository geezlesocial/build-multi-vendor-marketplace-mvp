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
    color: "",
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
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);
  const createLock = useRef(false);
  const productMedia = useSellerProductMedia({ request, reload, setMessage });
  const {
    media,
    uploading,
    uploadProgress,
    uploadFiles,
  } = productMedia;
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
  const createListing = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createLock.current) return;
    const priceMinor = Number(form.priceMinor);
    const salePriceMinor =
      form.salePriceMinor === "" ? null : Number(form.salePriceMinor);
    const stock = Number(form.stock);
    if (
      !Number.isSafeInteger(priceMinor) ||
      priceMinor < 1 ||
      (salePriceMinor !== null &&
        (!Number.isSafeInteger(salePriceMinor) ||
          salePriceMinor < 1 ||
          salePriceMinor >= priceMinor)) ||
      !Number.isSafeInteger(stock) ||
      stock < 0
    ) {
      setMessage(
        "Check the regular price, lower sale price, and available stock.",
      );
      return;
    }
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
    if (taxonomyLoading || !productTypes.length) {
      setMessage(
        "Approved product types are still loading or unavailable. Try again shortly.",
      );
      return;
    }
    createLock.current = true;
    setCreating(true);
    setMessage("");
    try {
      await request("/api/products", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          priceMinor,
          salePriceMinor,
          color: form.color || null,
          stock,
          wholesaleMinQuantity,
          wholesaleMaxQuantity,
        }),
      });
      setForm({
        name: "",
        description: "",
        priceMinor: 1000,
        salePriceMinor: "",
        stock: 1,
        categoryId: null,
        brandId: null,
        productTypeId: productTypes[0]?.id ?? "",
        color: "",
        featureIds: [],
        wholesaleEnabled: false,
        wholesaleMinQuantity: "2",
        wholesaleMaxQuantity: "99",
      });
      setMessage(
        "Listing created and sent through the configured product review policy.",
      );
      await reload();
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
