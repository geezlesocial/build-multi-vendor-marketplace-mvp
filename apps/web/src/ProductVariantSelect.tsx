import type { PublicProductVariant } from "./ProductMediaGallery.js";

export function ProductVariantSelect({
  productName,
  variants,
  value,
  onChange,
}: {
  productName: string;
  variants: readonly PublicProductVariant[];
  value: string;
  onChange: (variantId: string) => void;
}) {
  if (!variants.length) return null;
  return (
    <label className="productVariantSelect">
      Color / option
      <select
        aria-label={`Choose a color or option for ${productName}`}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose an option</option>
        {variants.map((variant) => (
          <option
            key={variant.id}
            value={variant.id}
            disabled={variant.stock < 1}
          >
            {variant.name} ·{" "}
            {variant.stock > 0 ? `${variant.stock} available` : "Out of stock"}
          </option>
        ))}
      </select>
    </label>
  );
}
