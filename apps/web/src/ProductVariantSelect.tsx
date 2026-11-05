import { useId } from "react";
import type { PublicProductVariant } from "./ProductMediaGallery.js";

const colorSwatches: Record<string, string> = {
  black: "#202421",
  white: "#ffffff",
  gray: "#8b9290",
  grey: "#8b9290",
  brown: "#795548",
  beige: "#d9c7a1",
  red: "#c9423a",
  orange: "#e87932",
  yellow: "#e8c83f",
  green: "#39835c",
  blue: "#3479b8",
  "ocean blue": "#176b91",
  navy: "#203a63",
  purple: "#7752a3",
  pink: "#df8fa9",
  clear: "#dce8e8",
  gold: "#c4a34b",
  silver: "#aeb6b8",
  multicolor:
    "linear-gradient(135deg,#e85a4f 0 25%,#e6c64b 25% 50%,#4d9f6e 50% 75%,#6486cf 75%)",
};

function swatchFor(name: string) {
  return colorSwatches[name.trim().toLocaleLowerCase()] ?? "#e5e9e5";
}

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
  const groupId = useId();
  if (!variants.length) return null;
  const selected = variants.find((variant) => variant.id === value);
  const firstAvailableIndex = variants.findIndex(
    (variant) => variant.stock > 0,
  );
  return (
    <section
      className="productVariantSelect"
      aria-labelledby={`variant-label-${groupId}`}
    >
      <fieldset className="productVariantSwatches">
        <legend id={`variant-label-${groupId}`}>
          Choose a color or option for {productName}
        </legend>
        <div className="productVariantSwatchGrid">
          {variants.map((variant, index) => (
            <label
              className={`productVariantSwatch${variant.id === value ? " is-selected" : ""}`}
              key={variant.id}
            >
              <input
                type="radio"
                name={`product-variant-${groupId}`}
                value={variant.id}
                checked={variant.id === value}
                disabled={variant.stock < 1}
                required={index === firstAvailableIndex}
                aria-label={`${variant.name}, ${variant.stock > 0 ? `${variant.stock} available` : "out of stock"}`}
                onChange={() => onChange(variant.id)}
              />
              {variant.image?.url ? (
                <img src={variant.image.url} alt="" loading="lazy" />
              ) : colorSwatches[variant.name.trim().toLowerCase()] ? (
                <span
                  className="productVariantSwatchDot"
                  style={{ background: swatchFor(variant.name) }}
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="productVariantSwatchInitial"
                  aria-hidden="true"
                >
                  {variant.name.trim().slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="productVariantSwatchName">{variant.name}</span>
              <small>
                {variant.stock > 0
                  ? `${variant.stock} available`
                  : "Out of stock"}
              </small>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="productVariantSelectionStatus" aria-live="polite">
        {selected
          ? `Selected option: ${selected.name}`
          : "Choose a color or option to see its price, availability, and product image."}
      </p>
      <details className="productVariantFallback">
        <summary>Choose from a list instead</summary>
        <label>
          Color / option
          <select
            aria-label={`Choose a color or option for ${productName}`}
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
                {variant.stock > 0
                  ? `${variant.stock} available`
                  : "Out of stock"}
              </option>
            ))}
          </select>
        </label>
      </details>
    </section>
  );
}
