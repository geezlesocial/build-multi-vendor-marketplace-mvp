import React, { useEffect, useRef, useState } from "react";
import {
  PRODUCT_MEDIA_ACCEPT,
  PRODUCT_MEDIA_LIMITS,
  productMediaCounts,
  productMediaKindForFile,
  uploadContentType,
  uploadToSignedPostWithType,
} from "./media-upload.js";
import {
  type CatalogBrand,
  type CatalogCategory,
  type CatalogProductType,
} from "./CatalogFields.js";
import { SellerDiscounts } from "./SellerDiscounts.js";
import { ProductManagement } from "./SellerProductList.js";

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
  const [media, setMedia] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [resourceErrors, setResourceErrors] = useState({
    media: "",
    taxonomy: "",
  });
  const [resourceRetry, setResourceRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const [taxonomyLoading, setTaxonomyLoading] = useState(true);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const createLock = useRef(false);
  useEffect(() => {
    let active = true;
    setMediaLoading(true);
    setTaxonomyLoading(true);
    setResourceErrors({ media: "", taxonomy: "" });
    const loadResources = async () => {
      const [mediaResult, taxonomyResult] = await Promise.allSettled([
        request<{ assets: any[] }>("/api/seller/store-media"),
        request<{
          categories: CatalogCategory[];
          brands: CatalogBrand[];
          productTypes: CatalogProductType[];
        }>("/api/catalog/taxonomy"),
      ]);
      if (!active) return;
      const failures: string[] = [];
      if (mediaResult.status === "fulfilled")
        setMedia(mediaResult.value.assets);
      else {
        const error = (mediaResult.reason as Error).message;
        failures.push(`Media library: ${error}`);
        setResourceErrors((current) => ({ ...current, media: error }));
      }
      setMediaLoading(false);
      if (taxonomyResult.status === "fulfilled") {
        const taxonomy = taxonomyResult.value;
        setCategories(taxonomy.categories);
        setBrands(taxonomy.brands);
        setProductTypes(taxonomy.productTypes);
        setForm((current) => ({
          ...current,
          productTypeId:
            current.productTypeId || taxonomy.productTypes[0]?.id || "",
        }));
      } else {
        const error = (taxonomyResult.reason as Error).message;
        failures.push(`Catalog options: ${error}`);
        setResourceErrors((current) => ({ ...current, taxonomy: error }));
      }
      setTaxonomyLoading(false);
      if (failures.length) setMessage(failures.join(" "));
    };
    void loadResources();
    return () => {
      active = false;
    };
  }, [resourceRetry]);
  const uploadFiles = async (files: File[], product?: any) => {
    if (uploadLock.current) return;
    const selected: { file: File; contentType: string }[] = [];
    const skipped: string[] = [];
    const counts = product ? productMediaCounts(product) : null;
    for (const file of files) {
      const contentType = uploadContentType(file);
      const kind = productMediaKindForFile(file.name);
      if (!contentType || !kind) {
        skipped.push(`${file.name}: unsupported file type.`);
        continue;
      }
      if (counts && counts[kind] >= PRODUCT_MEDIA_LIMITS[kind]) {
        skipped.push(
          `${file.name}: this product has reached its ${kind.toLowerCase()} limit.`,
        );
        continue;
      }
      if (counts) counts[kind] += 1;
      selected.push({ file, contentType });
    }
    if (!selected.length) {
      setMessage(
        skipped.join(" ") ||
          "Choose supported image, video, or document files.",
      );
      return;
    }

    uploadLock.current = true;
    setUploading(true);
    setUploadProgress(0);
    setMessage("");
    let attached = 0;
    let readyInLibrary = 0;
    let waitingForScan = 0;
    let attachedAny = false;
    const errors: string[] = [];
    try {
      for (const { file, contentType } of selected) {
        try {
          const reservation = await request<{
            id: string;
            upload: { url: string; fields: Record<string, string> };
          }>("/api/seller/store-media/uploads", {
            method: "POST",
            body: JSON.stringify({
              fileName: file.name,
              contentType,
              sizeBytes: file.size,
            }),
          });
          await uploadToSignedPostWithType(
            reservation.upload.url,
            reservation.upload.fields,
            file,
            setUploadProgress,
            contentType,
          );
          const finalized = await request<{ scanStatus: string }>(
            `/api/seller/store-media/${encodeURIComponent(reservation.id)}/finalize`,
            { method: "POST", body: "{}" },
          );
          if (finalized.scanStatus === "APPROVED" && product) {
            await request(
              `/api/products/${encodeURIComponent(product.id)}/media`,
              {
                method: "POST",
                body: JSON.stringify({
                  mediaAssetId: reservation.id,
                  label: file.name.replace(/\.[^.]+$/, ""),
                }),
              },
            );
            attached += 1;
            attachedAny = true;
          } else if (finalized.scanStatus === "APPROVED") readyInLibrary += 1;
          else waitingForScan += 1;
        } catch (error) {
          errors.push(`${file.name}: ${(error as Error).message}`);
        }
      }
      const result = await request<{ assets: any[] }>(
        "/api/seller/store-media",
      );
      setMedia(result.assets);
      if (attachedAny) reload();
      const summary = product
        ? `${attached} file(s) added to ${product.name}; ${waitingForScan} awaiting malware approval.`
        : `${readyInLibrary} file(s) scanned and ready to attach; ${waitingForScan} awaiting malware approval.`;
      setMessage([summary, ...skipped, ...errors].filter(Boolean).join(" "));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      uploadLock.current = false;
      setUploading(false);
      setUploadProgress(null);
    }
  };
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
      <section
        className="setting sellerProductModule sellerMediaUpload"
        aria-labelledby="product-library-heading"
      >
        <header className="sellerSectionHeading">
          <span className="sellerStep">02</span>
          <div>
            <p className="eyebrow">Shared media</p>
            <h3 id="product-library-heading">Product media library</h3>
            <p className="muted">
              Uploads stay private until scanning approves them. Attach approved
              assets to listings below.
            </p>
          </div>
        </header>
        <label>
          Choose images, video, or documents
          <input
            type="file"
            multiple
            accept={PRODUCT_MEDIA_ACCEPT}
            disabled={uploading}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length) void uploadFiles(files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {mediaLoading && (
          <small role="status" aria-busy="true">
            Loading media library…
          </small>
        )}
        {resourceErrors.media && (
          <p className="notice" role="alert">
            Media library could not be loaded: {resourceErrors.media}{" "}
            <button
              type="button"
              onClick={() => setResourceRetry((value) => value + 1)}
            >
              Retry
            </button>
          </p>
        )}
        {uploadProgress !== null && (
          <progress
            value={uploadProgress}
            max="100"
            aria-label="Upload progress"
          />
        )}
        {!mediaLoading && !resourceErrors.media && (
          <small>
            {media.length} uploaded asset(s); only completed, scanned assets can
            be attached.
          </small>
        )}
      </section>
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
