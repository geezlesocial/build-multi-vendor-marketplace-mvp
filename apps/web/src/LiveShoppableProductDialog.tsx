import { useEffect, useRef, useState } from "react";
import { useSession } from "./session.js";
import { formatMinor } from "./money.js";
import type { LiveCartLine, LiveProduct } from "./live-shopping-types.js";

type LiveShoppingRequest = <T>(
  path: string,
  options?: RequestInit,
) => Promise<T>;

export function LiveShoppableProductDialog({
  sessionId,
  productId,
  onClose,
  request,
}: {
  sessionId: string;
  productId: string;
  onClose: () => void;
  request: LiveShoppingRequest;
}) {
  const { user } = useSession();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [product, setProduct] = useState<LiveProduct | null>(null);
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cartReviewOpen, setCartReviewOpen] = useState(false);
  const [cartReviewItems, setCartReviewItems] = useState<LiveCartLine[]>([]);
  const [cartReviewSelection, setCartReviewSelection] = useState<string | null>(
    null,
  );
  const checkoutFrameRef = useRef<HTMLIFrameElement>(null);
  const productCloseRef = useRef<HTMLButtonElement>(null);
  const checkoutWasOpen = useRef(false);
  const variants = product?.variants ?? [];
  const variant = variants.find((item) => item.id === variantId) ?? null;
  const stock = variant?.stock ?? product?.availableStock ?? 0;
  const minimumQuantity = product?.wholesaleEnabled
    ? Math.max(1, product.wholesaleMinQuantity ?? 1)
    : 1;
  const maximumQuantity = Math.min(
    99,
    stock,
    product?.wholesaleEnabled ? (product.wholesaleMaxQuantity ?? 99) : 99,
  );
  const unitPrice =
    variant?.priceMinor ?? product?.salePriceMinor ?? product?.priceMinor ?? 0;
  const currency = variant?.currency ?? product?.currency ?? "USD";
  const selectedCartKey = `${product?.id ?? ""}:${variantId}:${quantity}`;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void request<LiveProduct>(
      `/api/live-sessions/${encodeURIComponent(sessionId)}/products/${encodeURIComponent(productId)}`,
    )
      .then((value) => {
        if (!current) return;
        setProduct(value);
        setVariantId(value.variants?.[0]?.id ?? "");
        setQuantity(
          Math.max(
            1,
            value.wholesaleEnabled ? (value.wholesaleMinQuantity ?? 1) : 1,
          ),
        );
      })
      .catch((reason) => {
        if (current) setError((reason as Error).message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [sessionId, productId, request]);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], iframe[title]",
        ),
      );
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === focusable.at(-1)
      ) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (checkoutOpen) {
      checkoutWasOpen.current = true;
      checkoutFrameRef.current?.focus();
    } else if (checkoutWasOpen.current) {
      checkoutWasOpen.current = false;
      productCloseRef.current?.focus();
    }
  }, [checkoutOpen]);

  const addToCart = async (reviewFullCart = false) => {
    if (!product || !user || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (reviewFullCart && cartReviewSelection !== selectedCartKey) {
        await request("/api/cart/items", {
          method: "POST",
          body: JSON.stringify({
            productId: product.id,
            ...(variantId ? { variantId } : {}),
            quantity,
          }),
        });
        window.dispatchEvent(new Event("marketplace:cart-changed"));
        // Do not add the item again if loading the cart summary fails and the
        // buyer retries. The server cart remains authoritative and untouched.
        setCartReviewSelection(selectedCartKey);
      } else if (!reviewFullCart) {
        await request("/api/cart/items", {
          method: "POST",
          body: JSON.stringify({
            productId: product.id,
            ...(variantId ? { variantId } : {}),
            quantity,
          }),
        });
        window.dispatchEvent(new Event("marketplace:cart-changed"));
        setMessage("Added to your cart. Keep watching or add another item.");
        return;
      }
      if (reviewFullCart) {
        const cart = await request<{ items: LiveCartLine[] }>("/api/cart");
        if (!cart.items.length)
          throw new Error("Your cart is empty. No checkout was opened.");
        setCartReviewItems(cart.items);
        setCartReviewOpen(true);
      } else {
        setMessage("Added to your cart.");
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="liveProductBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={
          checkoutOpen
            ? "liveProductDialog checkoutOpen"
            : cartReviewOpen
              ? "liveProductDialog cartReviewOpen"
              : "liveProductDialog"
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={
          checkoutOpen
            ? "live-checkout-dialog-title"
            : cartReviewOpen
              ? "live-cart-review-title"
              : "live-product-dialog-title"
        }
        aria-describedby={
          checkoutOpen
            ? "live-checkout-dialog-help"
            : cartReviewOpen
              ? "live-cart-review-help"
              : "live-product-dialog-help"
        }
        ref={dialogRef}
      >
        <button
          type="button"
          className="liveProductDialogClose"
          onClick={onClose}
          aria-label={
            checkoutOpen
              ? "Close checkout and return to live show"
              : cartReviewOpen
                ? "Close cart review and return to live show"
                : "Close product details"
          }
          ref={productCloseRef}
        >
          ×
        </button>
        {cartReviewOpen ? (
          <div className="liveCartReview">
            <header>
              <div>
                <p className="eyebrow">Before checkout</p>
                <h3 id="live-cart-review-title">Review your full cart</h3>
                <p id="live-cart-review-help">
                  This checkout includes every item listed below, including
                  items that were already in your cart. Nothing has been removed
                  and no order has been placed.
                </p>
              </div>
            </header>
            <ul aria-label="All items included in checkout">
              {cartReviewItems.map((item) => {
                const unitPrice =
                  item.variant?.priceMinor ??
                  item.product.salePriceMinor ??
                  item.product.priceMinor;
                const currency =
                  item.variant?.currency ?? item.product.currency;
                return (
                  <li key={item.id}>
                    <span>
                      <strong>
                        {item.quantity} × {item.product.name}
                      </strong>
                      {item.variant && (
                        <small>Option: {item.variant.name}</small>
                      )}
                    </span>
                    <strong>
                      {formatMinor(unitPrice * item.quantity, currency)}
                    </strong>
                  </li>
                );
              })}
            </ul>
            <div className="liveCartReviewTotals">
              <strong>Merchandise subtotal</strong>
              {Array.from(
                cartReviewItems.reduce((totals, item) => {
                  const currency =
                    item.variant?.currency ?? item.product.currency;
                  const unitPrice =
                    item.variant?.priceMinor ??
                    item.product.salePriceMinor ??
                    item.product.priceMinor;
                  totals.set(
                    currency,
                    (totals.get(currency) ?? 0) + unitPrice * item.quantity,
                  );
                  return totals;
                }, new Map<string, number>()),
              ).map(([currency, total]) => (
                <strong key={currency}>{formatMinor(total, currency)}</strong>
              ))}
            </div>
            <p>
              Shipping and applicable discounts are calculated in checkout.
              Review the final order total there before selecting Place order.
              Your live show stays open.
            </p>
            {error && (
              <p role="alert" className="notice">
                {error}
              </p>
            )}
            <div className="liveProductDialogActions">
              <button
                type="button"
                onClick={() => {
                  setCartReviewOpen(false);
                  setError("");
                }}
              >
                Back to item
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setCartReviewOpen(false);
                  setCheckoutOpen(true);
                }}
              >
                Continue with all cart items
              </button>
            </div>
          </div>
        ) : checkoutOpen ? (
          <div className="liveProductCheckout">
            <header>
              <div>
                <p className="eyebrow">Secure marketplace checkout</p>
                <h3 id="live-checkout-dialog-title">Complete your order</h3>
                <p id="live-checkout-dialog-help">
                  Your live show continues behind this checkout. Shipping,
                  stock, and payment rules are validated by the marketplace.
                </p>
              </div>
              <button type="button" onClick={() => setCheckoutOpen(false)}>
                Back to product
              </button>
            </header>
            <iframe
              ref={checkoutFrameRef}
              title="Secure checkout while watching live shopping"
              src="/checkout?source=live-shopping&embed=1"
              loading="eager"
            />
            <a
              href="/checkout?source=live-shopping"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open checkout in a separate tab
            </a>
          </div>
        ) : loading ? (
          <p role="status" className="liveProductDialogLoading">
            Loading current product details…
          </p>
        ) : error && !product ? (
          <div>
            <h3 id="live-product-dialog-title">Product unavailable</h3>
            <p className="notice" role="alert">
              {error}
            </p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          product && (
            <>
              <div className="liveProductDialogMedia">
                {product.images?.[0] ? (
                  <img
                    src={product.images[0].url}
                    alt={product.images[0].alt || product.name}
                  />
                ) : (
                  <span aria-hidden="true">{product.name.slice(0, 1)}</span>
                )}
              </div>
              <div className="liveProductDialogContent">
                <p className="eyebrow">Featured on this live show</p>
                <h3 id="live-product-dialog-title">{product.name}</h3>
                <p>{product.description}</p>
                <strong className="liveProductDialogPrice">
                  {formatMinor(unitPrice, currency)}
                </strong>
                <span
                  className={
                    stock > 0
                      ? "liveProductStock"
                      : "liveProductStock unavailable"
                  }
                >
                  {stock > 0 ? `${stock} available` : "Currently out of stock"}
                </span>
                {variants.length > 0 && (
                  <label>
                    Choose an option
                    <select
                      value={variantId}
                      onChange={(event) => {
                        setVariantId(event.target.value);
                        setQuantity(Math.max(1, minimumQuantity));
                      }}
                    >
                      <option value="">Choose a variant</option>
                      {variants.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={item.stock < 1}
                        >
                          {item.name} ·{" "}
                          {formatMinor(item.priceMinor, item.currency)} ·{" "}
                          {item.stock} available
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Quantity
                  <input
                    type="number"
                    min={minimumQuantity}
                    max={Math.max(0, maximumQuantity)}
                    value={quantity}
                    disabled={maximumQuantity < minimumQuantity}
                    onChange={(event) =>
                      setQuantity(
                        Math.max(
                          minimumQuantity,
                          Math.min(
                            maximumQuantity,
                            Number(event.target.value) || minimumQuantity,
                          ),
                        ),
                      )
                    }
                  />
                </label>
                {product.wholesaleEnabled && (
                  <small>
                    Wholesale orders require {minimumQuantity}–
                    {product.wholesaleMaxQuantity ?? 99} units.
                  </small>
                )}
                <small id="live-product-dialog-help">
                  Availability and price are checked again by the marketplace
                  when you add this item. Checkout keeps existing shipping and
                  payment rules.
                </small>
                {user ? (
                  <div className="liveProductDialogActions">
                    <button
                      type="button"
                      disabled={
                        busy ||
                        stock < minimumQuantity ||
                        quantity < minimumQuantity ||
                        (variants.length > 0 && !variantId)
                      }
                      onClick={() => void addToCart(false)}
                    >
                      {busy ? "Adding…" : "Add to cart"}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        busy ||
                        stock < minimumQuantity ||
                        quantity < minimumQuantity ||
                        (variants.length > 0 && !variantId)
                      }
                      onClick={() => void addToCart(true)}
                    >
                      {busy
                        ? "Preparing…"
                        : cartReviewSelection === selectedCartKey
                          ? "Review full cart"
                          : "Add & review full cart"}
                    </button>
                  </div>
                ) : (
                  <a
                    className="primary liveProductSignIn"
                    href="/?auth=login"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Sign in to shop
                  </a>
                )}
                {message && (
                  <p role="status" className="liveProductDialogMessage">
                    {message}
                  </p>
                )}
                {error && (
                  <p role="alert" className="notice">
                    {error}
                  </p>
                )}
              </div>
            </>
          )
        )}
      </section>
    </div>
  );
}
