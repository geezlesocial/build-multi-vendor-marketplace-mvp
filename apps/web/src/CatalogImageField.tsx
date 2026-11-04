import { BrandingImageControl } from "./BrandingImageControl.js";
import { catalogImageId, catalogImageUrl } from "./admin-catalog-helpers.js";

export function CatalogImageField({
  label,
  value,
  originalValue,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string | null;
  originalValue?: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const mediaId = catalogImageId(value);
  const originalMediaId = catalogImageId(originalValue);
  return (
    <div className="catalogImageField">
      {value && !mediaId && value === originalValue && (
        <p className="notice" role="note">
          This saved image is not from the approved media library. It will be
          preserved unless you choose a replacement or remove it.
        </p>
      )}
      <BrandingImageControl
        label={label}
        ratio={1}
        value={mediaId}
        publishedValue={originalValue === undefined ? null : originalMediaId}
        onChange={(id) => onChange(catalogImageUrl(id))}
        listUrl="/api/admin/platform/branding-media"
        uploadUrl="/api/admin/platform/branding-media/uploads"
        previewUrl={(id) =>
          `/api/admin/platform/branding-media/${encodeURIComponent(id)}/preview`
        }
        disabled={disabled}
      />
      {value && (
        <button
          type="button"
          className="catalogImageRemove"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Remove saved image
        </button>
      )}
    </div>
  );
}
