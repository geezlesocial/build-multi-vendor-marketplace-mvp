import { ProductEditor } from "./SellerProductEditor.js";
import type {
  CatalogBrand,
  CatalogCategory,
  CatalogProductType,
} from "./CatalogFields.js";

type DashboardRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export function ProductManagement({
  products,
  media,
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
  products: any[];
  media: any[];
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
  const approvedMedia = media.filter(
    (asset) =>
      ["IMAGE", "VIDEO", "DOCUMENT"].includes(asset.kind) &&
      asset.uploadStatus === "COMPLETE" &&
      asset.scanStatus === "APPROVED",
  );
  return (
    <div className="sellerProductManagement">
      {products.map((product) => (
        <ProductEditor
          key={product.id}
          product={product}
          approvedMedia={approvedMedia}
          categories={categories}
          brands={brands}
          productTypes={productTypes}
          reload={reload}
          setMessage={setMessage}
          onUploadFiles={onUploadFiles}
          uploading={uploading}
          uploadProgress={uploadProgress}
          request={request}
        />
      ))}
    </div>
  );
}
