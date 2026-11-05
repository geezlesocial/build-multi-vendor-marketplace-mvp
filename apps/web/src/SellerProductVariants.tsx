import { useId, useState } from "react";
import { normalizeColorVariantName } from "./SellerColorVariantFields.js";

type SellerVariant = {
  id: string;
  name: string;
  sku: string;
  priceMinor: number;
  currency: string;
  stock: number;
  status: string;
  mediaAssetId: string | null;
};

type DashboardRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

const freshDraft = (priceMinor: number, stock: number) => ({
  name: "",
  sku: "",
  priceMinor: String(priceMinor),
  stock: String(stock),
  mediaAssetId: "",
});

export function SellerProductVariants({
  product,
  approvedMedia,
  request,
  reload,
  setMessage,
}: {
  product: {
    id: string;
    name: string;
    priceMinor: number;
    inventory?: { quantity: number } | null;
    productType?: { requiresShipping?: boolean } | null;
    variants?: SellerVariant[];
  };
  approvedMedia: { id: string; originalName: string; kind: string }[];
  request: DashboardRequest;
  reload: () => void;
  setMessage: (message: string) => void;
}) {
  const variants = product.variants ?? [];
  const [draft, setDraft] = useState(() =>
    freshDraft(product.priceMinor, product.inventory?.quantity ?? 0),
  );
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const colorListId = useId();
  const images = approvedMedia.filter((asset) => asset.kind === "IMAGE");

  if (!product.productType?.requiresShipping && variants.length === 0)
    return null;

  const reset = () => {
    setEditingId("");
    setDraft(freshDraft(product.priceMinor, product.inventory?.quantity ?? 0));
    setPreviewError("");
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const normalizedName = normalizeColorVariantName(draft.name);
    if (variants.some((variant) => variant.id !== editingId && normalizeColorVariantName(variant.name) === normalizedName)) {
      setPreviewError("A color with that name already exists on this listing.");
      return;
    }
    setBusy(true);
    setPreviewError("");
    try {
      const body = {
        name: draft.name.trim(),
        sku: draft.sku.trim(),
        priceMinor: Number(draft.priceMinor),
        stock: Number(draft.stock),
        mediaAssetId: draft.mediaAssetId || null,
      };
      const path = `/api/products/${encodeURIComponent(product.id)}/variants${editingId ? `/${encodeURIComponent(editingId)}` : ""}`;
      await request(path, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      setMessage(
        editingId
          ? "Color option saved. The listing may need review before it is public."
          : "Color option added. It will appear publicly after listing approval.",
      );
      reset();
      reload();
    } catch (error) {
      setPreviewError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const edit = (variant: SellerVariant) => {
    setEditingId(variant.id);
    setDraft({
      name: variant.name,
      sku: variant.sku,
      priceMinor: String(variant.priceMinor),
      stock: String(variant.stock),
      mediaAssetId: variant.mediaAssetId ?? "",
    });
    setPreviewError("");
  };

  const remove = async (variant: SellerVariant) => {
    if (busy) return;
    setBusy(true);
    setPreviewError("");
    try {
      await request(
        `/api/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(variant.id)}`,
        { method: "DELETE" },
      );
      setMessage(`${variant.name} removed from this listing.`);
      if (editingId === variant.id) reset();
      reload();
    } catch (error) {
      setPreviewError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectedImage = images.find((asset) => asset.id === draft.mediaAssetId);

  return (
    <section
      className="sellerVariantManager"
      aria-labelledby={`variant-heading-${product.id}`}
    >
      <header>
        <div>
          <p className="eyebrow">Color and inventory</p>
          <h4 id={`variant-heading-${product.id}`}>Color options</h4>
        </div>
        <small>{variants.length} option(s)</small>
      </header>
      <p className="muted">
        Each option has its own price and stock. An approved image is optional;
        without one, buyers see the product’s default image. New or edited
        options are reviewed before they become public.
      </p>
      {variants.length > 0 && (
        <ul className="sellerVariantList">
          {variants.map((variant) => (
            <li key={variant.id}>
              {variant.mediaAssetId ? (
                <img
                  src={`/api/seller/store-media/${encodeURIComponent(variant.mediaAssetId)}/preview`}
                  alt={`${variant.name} option preview`}
                  loading="lazy"
                />
              ) : (
                <span className="sellerVariantImageFallback" aria-hidden="true">
                  {variant.name.slice(0, 1)}
                </span>
              )}
              <div className="sellerVariantSummary">
                <strong>{variant.name}</strong>
                <small>
                  {variant.sku} · {variant.status} · {variant.stock} in stock ·{" "}
                  {variant.currency} {variant.priceMinor}
                </small>
              </div>
              <div className="sellerVariantActions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => edit(variant)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(variant)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="sellerVariantForm"
        onSubmit={(event) => void save(event)}
      >
        <h5>{editingId ? "Edit color option" : "Add a color option"}</h5>
        <label>
          Search or enter a color
          <input
            type="search"
            required
            minLength={1}
            maxLength={120}
            list={colorListId}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
            placeholder="Ocean Blue"
          />
          <datalist id={colorListId}>
            {["Black", "White", "Gray", "Brown", "Beige", "Red", "Orange", "Yellow", "Green", "Blue", "Ocean Blue", "Navy", "Purple", "Pink", "Multicolor", "Clear", "Gold", "Silver"].map((color) => (
              <option key={color} value={color} />
            ))}
          </datalist>
        </label>
        <label>
          SKU
          <input
            required
            minLength={2}
            maxLength={80}
            value={draft.sku}
            onChange={(event) =>
              setDraft({ ...draft, sku: event.target.value })
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
            value={draft.priceMinor}
            onChange={(event) =>
              setDraft({ ...draft, priceMinor: event.target.value })
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
            value={draft.stock}
            onChange={(event) =>
              setDraft({ ...draft, stock: event.target.value })
            }
          />
        </label>
        <label className="sellerVariantImageField">
          Approved color image (optional)
          <select
            value={draft.mediaAssetId}
            onChange={(event) =>
              setDraft({ ...draft, mediaAssetId: event.target.value })
            }
          >
            <option value="">Use the product’s default image</option>
            {images.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.originalName}
              </option>
            ))}
          </select>
        </label>
        {selectedImage && (
          <div className="sellerVariantImageAssignment">
            <img
              className="sellerVariantSelectedPreview"
              src={`/api/seller/store-media/${encodeURIComponent(selectedImage.id)}/preview`}
              alt={`Preview of ${draft.name || "selected color"} image`}
              loading="lazy"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft({ ...draft, mediaAssetId: "" })}
            >
              Remove color image
            </button>
          </div>
        )}
        <div className="sellerVariantFormActions">
          <button type="submit" disabled={busy}>
            {busy
              ? "Saving…"
              : editingId
                ? "Save color option"
                : "Add color option"}
          </button>
          {editingId && (
            <button type="button" disabled={busy} onClick={reset}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      {previewError && (
        <p className="notice" role="alert">
          {previewError}
        </p>
      )}
    </section>
  );
}
