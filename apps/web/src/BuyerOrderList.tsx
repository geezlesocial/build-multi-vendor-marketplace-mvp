import { useEffect, useRef, useState } from "react";
import type { BuyerOrder } from "./buyer-dashboard-types.js";
import { OrderResolutionPanel } from "./OrderResolutionPanel.js";
import { money, request } from "./DashboardShared.js";

export function OrderList({
  orders,
  reload,
  compact = false,
  onViewAll,
}: {
  orders: BuyerOrder[];
  reload: () => void;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [receiptTarget, setReceiptTarget] = useState<{
    parentOrderId: string;
    sellerOrderId: string;
    paymentMethod: string;
  } | null>(null);
  const [receiptSaving, setReceiptSaving] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (receiptTarget && !dialog.open) dialog.showModal();
    else if (!receiptTarget && dialog.open) dialog.close();
  }, [receiptTarget]);
  const confirmReceipt = async () => {
    if (!receiptTarget || receiptSaving) return;
    setReceiptSaving(true);
    setReceiptError("");
    try {
      await request(
        `/api/orders/${encodeURIComponent(receiptTarget.parentOrderId)}/shipments/${encodeURIComponent(receiptTarget.sellerOrderId)}/confirm-received`,
        { method: "POST", body: "{}" },
      );
      setReceiptTarget(null);
      window.dispatchEvent(new Event("marketplace:orders-changed"));
      await reload();
    } catch (error) {
      setReceiptError((error as Error).message);
    } finally {
      setReceiptSaving(false);
    }
  };
  const readableStatus = (status: string) =>
    status
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^./, (value) => value.toUpperCase());
  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  return (
    <section className={`buyerOrders${compact ? " buyerOrders--compact" : ""}`}>
      <header className="ordersSectionHeading">
        <div>
          <p className="eyebrow">
            {compact ? "Your purchases" : "Order tracking"}
          </p>
          <h2>{compact ? "Recent orders" : "Orders and delivery"}</h2>
          <p className="muted">
            {compact
              ? "Your latest purchases and delivery updates."
              : "Track Store updates and confirm receipt after your item ships."}
          </p>
        </div>
        {compact ? (
          <button
            className="dashboardTextAction"
            type="button"
            onClick={onViewAll}
          >
            View all orders <span aria-hidden="true">→</span>
          </button>
        ) : (
          <span className="ordersLiveBadge">
            <i aria-hidden="true" />
            Updates every 10 seconds
          </span>
        )}
      </header>
      {orders.length === 0 ? (
        compact ? (
          <div className="buyerOrderEmptyState">
            <div>
              <strong>No purchases yet</strong>
              <p>Your order and delivery updates will appear here.</p>
            </div>
            <a className="primary" href="/">
              Browse products
            </a>
          </div>
        ) : (
          <div className="empty">No orders yet.</div>
        )
      ) : (
        <div className="buyerOrderList">
          {orders.map((order) => (
            <details
              className="buyerOrderCard"
              key={order.id}
              open={orders.length === 1}
            >
              <summary>
                <span>
                  <strong>{order.orderNumber}</strong>
                  <small>
                    {dateLabel(order.createdAt)} ·{" "}
                    {order.payment?.method ?? "Payment pending"}
                  </small>
                </span>
                <span className="buyerOrderTotal">
                  {money(order.totalMinor, order.currency)}
                  <small>{readableStatus(order.status)}</small>
                </span>
              </summary>
              <div className="buyerOrderBody">
                <p className="orderPaymentStatus">
                  Payment status:{" "}
                  <strong>
                    {readableStatus(order.payment?.status ?? "PENDING")}
                  </strong>
                </p>
                {order.sellerOrders?.map((sellerOrder) => (
                  <article className="buyerShipmentCard" key={sellerOrder.id}>
                    <header>
                      <div>
                        <p className="eyebrow">
                          {sellerOrder.seller?.store?.name ??
                            "Marketplace Store"}
                        </p>
                        <h3>
                          {sellerOrder.shipmentStatus
                            ? readableStatus(sellerOrder.shipmentStatus)
                            : sellerOrder.status === "CANCELLED"
                              ? "Cancelled"
                              : "Preparing your order"}
                        </h3>
                      </div>
                      {sellerOrder.receivedAt && (
                        <span className="receiptStatusBadge">
                          Receipt confirmed
                        </span>
                      )}
                    </header>
                    {sellerOrder.shippingCarrier && (
                      <p className="trackingDetails">
                        <strong>{sellerOrder.shippingCarrier}</strong>
                        {sellerOrder.trackingNumber && (
                          <> · Tracking {sellerOrder.trackingNumber}</>
                        )}
                        {sellerOrder.trackingUrl && (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={sellerOrder.trackingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Track with carrier
                            </a>
                          </>
                        )}
                      </p>
                    )}
                    {sellerOrder.shipmentUpdates?.length > 0 && (
                      <ol
                        className="shipmentTimeline"
                        aria-label="Shipment progress"
                      >
                        {[...sellerOrder.shipmentUpdates]
                          .reverse()
                          .map((update) => (
                            <li key={update.id}>
                              <span
                                className="shipmentTimelineDot"
                                aria-hidden="true"
                              />
                              <div>
                                <strong>{readableStatus(update.status)}</strong>
                                {update.note && <p>{update.note}</p>}
                                <small>
                                  {update.carrier ??
                                    sellerOrder.shippingCarrier ??
                                    "Seller update"}{" "}
                                  · {dateLabel(update.createdAt)}
                                </small>
                              </div>
                            </li>
                          ))}
                      </ol>
                    )}
                    {sellerOrder.deliveredAt && (
                      <p className="muted">
                        Seller marked delivered{" "}
                        {dateLabel(sellerOrder.deliveredAt)}.
                      </p>
                    )}
                    {sellerOrder.receivedAt ? (
                      <p className="receiptConfirmedLine" role="status">
                        You confirmed receipt in good condition on{" "}
                        {dateLabel(sellerOrder.receivedAt)}. Online seller
                        proceeds remain subject to the configured payout hold.
                      </p>
                    ) : (
                      sellerOrder.shippedAt &&
                      order.payment?.method !== "POS" && (
                        <div className="receiptAction">
                          <p className="muted">
                            Only confirm after the item is in your possession
                            and you have checked its condition.
                          </p>
                          <button
                            className="primary"
                            type="button"
                            onClick={() => {
                              setReceiptError("");
                              setReceiptTarget({
                                parentOrderId: order.id,
                                sellerOrderId: sellerOrder.id,
                                paymentMethod:
                                  order.payment?.method ?? "UNKNOWN",
                              });
                            }}
                          >
                            Confirm item received
                          </button>
                        </div>
                      )
                    )}
                    {order.payment?.method === "COD" && (
                      <p className="notice shipmentPaymentNotice">
                        Cash on delivery is paid to the seller on delivery; the
                        marketplace does not hold COD funds in its payout
                        ledger.
                      </p>
                    )}
                    {sellerOrder.items?.map((item) => (
                      <p className="buyerOrderItem" key={item.id}>
                        {item.quantity} × {item.productName} ·{" "}
                        {money(
                          item.unitPriceMinor,
                          item.currencySnapshot ?? order.currency,
                        )}
                      </p>
                    ))}
                    <OrderResolutionPanel
                      mode="buyer"
                      parentOrderId={order.id}
                      sellerOrder={sellerOrder}
                      currency={order.currency}
                      reload={reload}
                    />
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
      <dialog
        ref={dialogRef}
        className="receiptConfirmDialog"
        aria-labelledby="receipt-confirm-title"
        onClose={() => {
          if (receiptTarget) setReceiptTarget(null);
        }}
      >
        <p className="eyebrow">Buyer protection</p>
        <h2 id="receipt-confirm-title">Confirm receipt and condition</h2>
        <p>
          You are confirming that this item is in your possession and was
          received in good condition. Do not confirm if anything is missing,
          damaged, or not as described.
        </p>
        {receiptTarget?.paymentMethod === "COD" ? (
          <p className="notice">
            This was a cash-on-delivery order. The seller collects COD payment
            on delivery; the marketplace cannot hold those cash funds.
          </p>
        ) : (
          <p className="notice">
            After confirmation, in-app cancellation, refund, or dispute requests
            for this item may no longer be available, except where applicable
            law or your payment provider requires otherwise. This confirmation
            does not waive statutory rights or payment-provider protections.
          </p>
        )}
        {receiptError && (
          <p className="notice" role="alert">
            {receiptError}
          </p>
        )}
        <div className="receiptDialogActions">
          <button
            type="button"
            autoFocus
            disabled={receiptSaving}
            onClick={() => setReceiptTarget(null)}
          >
            Go back
          </button>
          <button
            className="primary"
            type="button"
            disabled={receiptSaving}
            onClick={() => void confirmReceipt()}
          >
            {receiptSaving
              ? "Confirming…"
              : "Confirm received in good condition"}
          </button>
        </div>
      </dialog>
    </section>
  );
}
