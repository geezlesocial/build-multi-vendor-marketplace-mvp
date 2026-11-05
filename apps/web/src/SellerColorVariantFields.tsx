import { useId, useState } from "react";

export type SellerColorVariantDraft = {
  key: string;
  name: string;
  sku: string;
  priceMinor: string;
  stock: string;
  mediaAssetId: string;
  status?: "saving" | "saved" | "failed";
  error?: string;
};

export type ApprovedColorImage = {
  id: string;
  originalName: string;
};

export function normalizeColorVariantName(value: string) {
  return value.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

const suggestedColors = [
  "Black",
  "White",
  "Gray",
  "Brown",
  "Beige",
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Blue",
  "Ocean Blue",
  "Navy",
  "Purple",
  "Pink",
  "Multicolor",
  "Clear",
  "Gold",
  "Silver",
];

function newKey() {
  return `color-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function SellerColorVariantFields({
  variants,
  onChange,
  approvedImages,
  defaultPriceMinor,
  defaultStock,
  disabled = false,
}: {
  variants: SellerColorVariantDraft[];
  onChange: (variants: SellerColorVariantDraft[]) => void;
  approvedImages: ApprovedColorImage[];
  defaultPriceMinor: number;
  defaultStock: number;
  disabled?: boolean;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const variant of variants) {
    const normalized = normalizeColorVariantName(variant.name);
    if (!normalized) continue;
    if (seenNames.has(normalized)) duplicateNames.add(variant.key);
    seenNames.add(normalized);
  }

  const add = () => {
    const name = query.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (
      variants.some(
        (variant) =>
          normalizeColorVariantName(variant.name) ===
          normalizeColorVariantName(name),
      )
    ) {
      setError(`${name} is already in this product's color options.`);
      return;
    }
    onChange([
      ...variants,
      {
        key: newKey(),
        name,
        sku: "",
        priceMinor: String(defaultPriceMinor),
        stock: String(defaultStock),
        mediaAssetId: "",
      },
    ]);
    setQuery("");
    setError("");
  };

  const update = (key: string, changes: Partial<SellerColorVariantDraft>) =>
    onChange(
      variants.map((variant) =>
        variant.key === key
          ? { ...variant, ...changes, status: undefined, error: undefined }
          : variant,
      ),
    );

  return (
    <fieldset
      className="sellerColorVariants"
      aria-describedby={`color-help-${listId}`}
    >
      <legend>Color variants</legend>
      <p id={`color-help-${listId}`} className="muted">
        Add one row per color. Each color keeps its own SKU, price, and stock. A
        dedicated image is optional; without one, buyers see the general product
        gallery.
      </p>
      <div className="sellerColorVariantPicker">
        <label htmlFor={`color-search-${listId}`}>
          Search or enter a color
        </label>
        <div>
          <input
            id={`color-search-${listId}`}
            type="search"
            list={listId}
            value={query}
            maxLength={120}
            placeholder="For example, Ocean Blue"
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <datalist id={listId}>
            {suggestedColors.map((color) => (
              <option key={color} value={color} />
            ))}
          </datalist>
          <button
            type="button"
            disabled={disabled || !query.trim()}
            onClick={add}
          >
            Add color
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="catalogFieldError">
          {error}
        </p>
      )}
      {duplicateNames.size > 0 && (
        <p role="alert" className="catalogFieldError">
          Color names must be unique. Rename duplicate options before saving.
        </p>
      )}
      {variants.length === 0 ? (
        <p className="sellerColorVariantEmpty">
          No color variants added. Color options are optional.
        </p>
      ) : (
        <ul className="sellerColorVariantRows">
          {variants.map((variant, index) => {
            const selectedImage = approvedImages.find(
              (image) => image.id === variant.mediaAssetId,
            );
            const locked =
              disabled ||
              variant.status === "saving" ||
              variant.status === "saved";
            return (
              <li className="sellerColorVariantRow" key={variant.key}>
                <header>
                  <strong>
                    Color {index + 1}: {variant.name || "Unnamed color"}
                  </strong>
                  {variant.status === "saved" && (
                    <span className="sellerVariantSaveStatus">Saved</span>
                  )}
                  {variant.status === "saving" && (
                    <span role="status">Saving…</span>
                  )}
                  {variant.status === "failed" && (
                    <span className="sellerVariantSaveStatus is-failed">
                      Needs retry
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${variant.name || `color ${index + 1}`}`}
                    disabled={locked}
                    onClick={() =>
                      onChange(
                        variants.filter((item) => item.key !== variant.key),
                      )
                    }
                  >
                    Remove color
                  </button>
                </header>
                <div className="sellerColorVariantInputs">
                  <label>
                    Color name
                    <input
                      required
                      maxLength={120}
                      value={variant.name}
                      disabled={locked}
                      aria-invalid={duplicateNames.has(variant.key)}
                      onChange={(event) =>
                        update(variant.key, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    SKU
                    <input
                      required
                      minLength={2}
                      maxLength={80}
                      value={variant.sku}
                      disabled={locked}
                      onChange={(event) =>
                        update(variant.key, { sku: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Price (minor units)
                    <input
                      required
                      type="number"
                      min="1"
                      step="1"
                      value={variant.priceMinor}
                      disabled={locked}
                      onChange={(event) =>
                        update(variant.key, { priceMinor: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Available stock
                    <input
                      required
                      type="number"
                      min="0"
                      step="1"
                      value={variant.stock}
                      disabled={locked}
                      onChange={(event) =>
                        update(variant.key, { stock: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="sellerColorVariantImageField">
                  Approved image for {variant.name || `color ${index + 1}`}{" "}
                  (optional)
                  <select
                    value={variant.mediaAssetId}
                    disabled={locked}
                    onChange={(event) =>
                      update(variant.key, { mediaAssetId: event.target.value })
                    }
                  >
                    <option value="">Use the general product image</option>
                    {approvedImages.map((image) => (
                      <option key={image.id} value={image.id}>
                        {image.originalName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sellerColorVariantImagePreview">
                  {selectedImage ? (
                    <>
                      <img
                        src={`/api/seller/store-media/${encodeURIComponent(selectedImage.id)}/preview`}
                        alt={`${variant.name} variant image preview`}
                        loading="lazy"
                      />
                      <span>{selectedImage.originalName}</span>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          update(variant.key, { mediaAssetId: "" })
                        }
                      >
                        Remove color image
                      </button>
                    </>
                  ) : (
                    <span>
                      General product image will be used for{" "}
                      {variant.name || "this color"}.
                    </span>
                  )}
                </div>
                {variant.error && (
                  <p role="alert" className="catalogFieldError">
                    {variant.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
