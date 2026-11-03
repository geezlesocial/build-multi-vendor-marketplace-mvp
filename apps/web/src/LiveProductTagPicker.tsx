import React, { useId, useState } from "react";
import { formatMinor } from "./money.js";
import type { LiveProduct } from "./live-shopping-types.js";

export function ProductTagPicker({
  products,
  productIds,
  featuredProductId,
  onProductIdsChange,
  onFeaturedProductChange,
  disabled = false,
}: {
  products: LiveProduct[];
  productIds: string[];
  featuredProductId: string;
  onProductIdsChange: (productIds: string[]) => void;
  onFeaturedProductChange: (productId: string) => void;
  disabled?: boolean;
}) {
  const radioGroup = useId();
  const [limitMessage, setLimitMessage] = useState("");
  const [search, setSearch] = useState("");
  const approvedProducts = products.filter(
    (product) => product.status === "APPROVED",
  );
  const visibleProducts = approvedProducts.filter((product) =>
    product.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const toggle = (productId: string, checked: boolean) => {
    setLimitMessage("");
    if (checked && productIds.length >= 6) {
      setLimitMessage(
        "A show can feature up to six products. Remove one before adding another.",
      );
      return;
    }
    const next = checked
      ? [...productIds, productId]
      : productIds.filter((id) => id !== productId);
    onProductIdsChange(next);
    if (checked && productIds.length === 0) onFeaturedProductChange(productId);
  };
  const move = (productId: string, direction: -1 | 1) => {
    const from = productIds.indexOf(productId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= productIds.length) return;
    const next = [...productIds];
    [next[from], next[to]] = [next[to]!, next[from]!];
    onProductIdsChange(next);
  };
  return (
    <fieldset className="liveProductTagPicker" disabled={disabled}>
      <legend>Featured products · {productIds.length}/6</legend>
      <p className="muted">
        Select up to six approved products from your Store. Selection order
        controls the live shelf; the pinned item is highlighted first.
      </p>
      {approvedProducts.length > 0 && (
        <label className="liveProductTagSearch">
          Search your products
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by product name"
            autoComplete="off"
          />
        </label>
      )}
      {visibleProducts.length ? (
        <div className="liveProductTagChoices">
          {visibleProducts.map((product) => {
            const selectedIndex = productIds.indexOf(product.id);
            const selected = selectedIndex >= 0;
            const availableStock =
              product.availableStock ?? product.inventory?.quantity;
            return (
              <div
                className={
                  selected
                    ? "liveProductTagChoice selected"
                    : "liveProductTagChoice"
                }
                key={product.id}
              >
                <label className="liveProductTagSelect">
                  <input
                    type="checkbox"
                    aria-label={`Feature ${product.name}`}
                    checked={selected}
                    onChange={(event) =>
                      toggle(product.id, event.currentTarget.checked)
                    }
                  />
                  {product.images?.[0]?.url ? (
                    <img
                      src={product.images[0].url}
                      alt={product.images[0].alt || ""}
                      loading="lazy"
                    />
                  ) : (
                    <span
                      className="liveProductTagPlaceholder"
                      aria-hidden="true"
                    >
                      {product.name.slice(0, 1)}
                    </span>
                  )}
                  <span className="liveProductTagDetails">
                    <strong>{product.name}</strong>
                    <small>
                      {typeof product.priceMinor === "number" &&
                      product.currency
                        ? formatMinor(
                            product.salePriceMinor ?? product.priceMinor,
                            product.currency,
                          )
                        : "Price unavailable"}
                    </small>
                    <small>
                      {typeof availableStock === "number"
                        ? `${availableStock} available`
                        : "Availability checked at checkout"}
                    </small>
                  </span>
                </label>
                {selected && (
                  <div className="liveProductTagOrder">
                    <span>#{selectedIndex + 1}</span>
                    <button
                      type="button"
                      aria-label={`Move ${product.name} earlier`}
                      disabled={disabled || selectedIndex === 0}
                      onClick={() => move(product.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${product.name} later`}
                      disabled={
                        disabled || selectedIndex === productIds.length - 1
                      }
                      onClick={() => move(product.id, 1)}
                    >
                      ↓
                    </button>
                    <label className="liveProductTagPin">
                      <input
                        type="radio"
                        name={radioGroup}
                        checked={featuredProductId === product.id}
                        onChange={() => onFeaturedProductChange(product.id)}
                      />{" "}
                      Pin
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : approvedProducts.length > 0 ? (
        <div className="empty">No approved products match that search.</div>
      ) : (
        <div className="empty">
          No approved products are available to feature yet.
        </div>
      )}
      <small>
        Older product links remain preserved in show history and are not removed
        when this shelf changes.
      </small>
      {limitMessage && (
        <small className="liveProductTagLimit" role="status">
          {limitMessage}
        </small>
      )}
    </fieldset>
  );
}
