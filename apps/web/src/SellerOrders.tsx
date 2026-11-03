import React, { useEffect, useState } from "react";
import { OrderResolutionPanel } from "./OrderResolutionPanel.js";
import { money, request } from "./DashboardShared.js";

export function SellerOrders({
  orders,
  sellerMode = false,
  reload,
}: {
  orders: any[];
  sellerMode?: boolean;
  reload: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [collectingCodOrderId, setCollectingCodOrderId] = useState<
    string | null
  >(null);
  const [codCollectionMessage, setCodCollectionMessage] = useState("");
  const collectCod = async (orderId: string) => {
    if (
      !window.confirm(
        "Confirm that you physically received the COD cash from the buyer. This records collection; the marketplace does not hold the cash.",
      )
    )
      return;
    setCollectingCodOrderId(orderId);
    setCodCollectionMessage("");
    try {
      await request(`/api/orders/${encodeURIComponent(orderId)}/cod-collect`, {
        method: "POST",
        body: "{}",
      });
      setCodCollectionMessage("COD collection recorded.");
      window.dispatchEvent(new Event("marketplace:orders-changed"));
      await reload();
    } catch (error) {
      setCodCollectionMessage((error as Error).message);
    } finally {
      setCollectingCodOrderId(null);
    }
  };
  const orderRows = orders.flatMap((order) => {
    const sellerOrder = order.sellerOrders?.[0];
    if (!sellerOrder) return [];
    const key = sellerOrder.receivedAt
      ? "completed"
      : sellerOrder.status === "CANCELLED"
        ? "cancelled"
        : sellerOrder.shipmentStatus === "EXCEPTION"
          ? "exceptions"
          : sellerOrder.shipmentStatus === "DELIVERED"
            ? "delivered"
            : ["SHIPPED", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(
                  sellerOrder.shipmentStatus,
                )
              ? "in-transit"
              : "to-ship";
    return [{ order, sellerOrder, key }];
  });
  const filters = [
    { id: "all", label: "All orders" },
    { id: "to-ship", label: "Needs shipment" },
    { id: "in-transit", label: "In transit" },
    { id: "delivered", label: "Delivered" },
    { id: "exceptions", label: "Exceptions" },
    { id: "completed", label: "Receipt confirmed" },
    { id: "cancelled", label: "Cancelled" },
  ];
  const visibleOrders =
    filter === "all"
      ? orderRows
      : orderRows.filter((row) => row.key === filter);
  const countFor = (id: string) =>
    id === "all"
      ? orderRows.length
      : orderRows.filter((row) => row.key === id).length;
  return (
    <section className="sellerOrders">
      <header className="ordersSectionHeading">
        <div>
          <p className="eyebrow">Fulfillment</p>
          <h2>Seller orders</h2>
          <p className="muted">
            Add tracking at dispatch and keep buyers informed as delivery
            progresses.
          </p>
        </div>
        <span className="sellerOrderCount">
          {visibleOrders.length} of {orderRows.length} orders
        </span>
      </header>
      {codCollectionMessage && (
        <p className="notice" role="status">
          {codCollectionMessage}
        </p>
      )}
      {orderRows.length === 0 ? (
        <div className="empty">No seller orders yet.</div>
      ) : (
        <>
          <nav className="sellerOrderFilters" aria-label="Filter seller orders">
            {filters.map((item) => (
              <button
                type="button"
                key={item.id}
                className={filter === item.id ? "active" : ""}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span>{countFor(item.id)}</span>
              </button>
            ))}
          </nav>
          {visibleOrders.length === 0 ? (
            <div className="empty sellerOrderEmpty">
              No orders in this status.
            </div>
          ) : (
            <div className="sellerOrderList">
              {visibleOrders.map(({ order, sellerOrder }) => {
                const status = sellerOrder.receivedAt
                  ? "RECEIPT CONFIRMED"
                  : (sellerOrder.shipmentStatus?.replaceAll("_", " ") ??
                    (sellerOrder.status === "CANCELLED"
                      ? "CANCELLED"
                      : "NEEDS SHIPMENT"));
                const itemNames =
                  sellerOrder.items
                    ?.map((item: any) => item.productName)
                    .join(", ") || "Order items";
                return (
                  <details className="sellerOrderCard" key={order.id}>
                    <summary className="sellerOrderSummary">
                      <span className="sellerOrderSummaryMain">
                        <span className="sellerOrderSummaryTop">
                          <span className="eyebrow">{order.orderNumber}</span>
                          <span className="sellerOrderStatus">{status}</span>
                        </span>
                        <strong>{itemNames}</strong>
                        <small>
                          {money(
                            sellerOrder.totalMinor ?? order.totalMinor,
                            order.currency,
                          )}{" "}
                          · {order.payment?.method ?? "Payment pending"} ·{" "}
                          {order.payment?.status ?? "PENDING"}
                        </small>
                      </span>
                      <span className="sellerOrderSummaryAside">
                        <strong>
                          {money(
                            sellerOrder.totalMinor ?? order.totalMinor,
                            order.currency,
                          )}
                        </strong>
                        <span className="sellerOrderExpandLabel">
                          View order <i aria-hidden="true" />
                        </span>
                      </span>
                    </summary>
                    <div className="sellerOrderDetails">
                      {sellerOrder.receivedAt ? (
                        <p className="receiptConfirmedLine">
                          Buyer confirmed receipt on{" "}
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(sellerOrder.receivedAt))}
                          . Eligible online proceeds remain subject to the
                          configured payout hold.
                        </p>
                      ) : order.payment?.method === "COD" ? (
                        <p className="notice shipmentPaymentNotice">
                          Cash on delivery is collected by the seller at
                          delivery and is not held by the platform.
                        </p>
                      ) : (
                        <p className="muted">
                          Online seller proceeds are not payout-eligible until
                          the buyer confirms receipt and the configured hold
                          period passes.
                        </p>
                      )}
                      {sellerMode &&
                        order.payment?.method === "COD" &&
                        order.payment?.status === "PENDING" &&
                        sellerOrder.shipmentStatus === "DELIVERED" &&
                        sellerOrder.deliveredAt &&
                        order._count?.sellerOrders === 1 && (
                          <div className="codCollectionAction">
                            <p className="muted">
                              Only confirm after you have received the cash from
                              the buyer.
                            </p>
                            <button
                              type="button"
                              className="primary"
                              disabled={collectingCodOrderId === order.id}
                              onClick={() => void collectCod(order.id)}
                            >
                              {collectingCodOrderId === order.id
                                ? "Recording COD collection…"
                                : "Confirm COD collected"}
                            </button>
                          </div>
                        )}
                      {sellerMode &&
                        order.payment?.method === "COD" &&
                        sellerOrder.shipmentStatus === "DELIVERED" &&
                        order._count?.sellerOrders > 1 && (
                          <p className="muted">
                            This order contains multiple Stores; COD collection
                            requires marketplace administrator review.
                          </p>
                        )}
                      {sellerMode && sellerOrder.sellerId && (
                        <SellerShipmentEditor
                          sellerOrder={sellerOrder}
                          reload={reload}
                        />
                      )}
                      {sellerMode && (
                        <OrderResolutionPanel
                          mode="seller"
                          parentOrderId={order.id}
                          sellerOrder={sellerOrder}
                          currency={order.currency}
                          reload={reload}
                        />
                      )}
                      {sellerMode && (
                        <label className="sellerOrderStatusControl">
                          Order processing status
                          <select
                            aria-label={`Order processing status for ${order.orderNumber}`}
                            defaultValue={sellerOrder.status}
                            onChange={async (event) => {
                              try {
                                await request(
                                  `/api/sellers/${sellerOrder.sellerId}/orders/${sellerOrder.id}/status`,
                                  {
                                    method: "POST",
                                    body: JSON.stringify({
                                      status: event.target.value,
                                    }),
                                  },
                                );
                                reload();
                              } catch (error) {
                                window.alert((error as Error).message);
                              }
                            }}
                          >
                            <option>PENDING</option>
                            <option>CONFIRMED</option>
                            <option>PROCESSING</option>
                            <option>FULFILLED</option>
                            <option>CANCELLED</option>
                          </select>
                        </label>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SellerShipmentEditor({
  sellerOrder,
  reload,
}: {
  sellerOrder: any;
  reload: () => void;
}) {
  const [status, setStatus] = useState(sellerOrder.shipmentStatus ?? "SHIPPED");
  const [carrier, setCarrier] = useState(sellerOrder.shippingCarrier ?? "");
  const [trackingNumber, setTrackingNumber] = useState(
    sellerOrder.trackingNumber ?? "",
  );
  const [trackingUrl, setTrackingUrl] = useState(sellerOrder.trackingUrl ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setStatus(sellerOrder.shipmentStatus ?? "SHIPPED");
    setCarrier(sellerOrder.shippingCarrier ?? "");
    setTrackingNumber(sellerOrder.trackingNumber ?? "");
    setTrackingUrl(sellerOrder.trackingUrl ?? "");
  }, [sellerOrder]);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || sellerOrder.receivedAt) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/sellers/${encodeURIComponent(sellerOrder.sellerId)}/orders/${encodeURIComponent(sellerOrder.id)}/shipping`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status,
            carrier,
            trackingNumber,
            trackingUrl,
            note,
          }),
        },
      );
      setMessage("Shipment progress saved and shared with the buyer.");
      setNote("");
      window.dispatchEvent(new Event("marketplace:orders-changed"));
      await reload();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (sellerOrder.receivedAt)
    return (
      <p className="muted">
        Shipping history is locked after buyer receipt confirmation.
      </p>
    );
  const nextStatuses =
    sellerOrder.shipmentStatus === "DELIVERED"
      ? ["DELIVERED"]
      : sellerOrder.shipmentStatus === "EXCEPTION"
        ? ["EXCEPTION", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]
        : sellerOrder.shipmentStatus === "OUT_FOR_DELIVERY"
          ? ["OUT_FOR_DELIVERY", "IN_TRANSIT", "DELIVERED", "EXCEPTION"]
          : sellerOrder.shipmentStatus === "IN_TRANSIT"
            ? ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "EXCEPTION"]
            : sellerOrder.shipmentStatus === "SHIPPED"
              ? [
                  "SHIPPED",
                  "IN_TRANSIT",
                  "OUT_FOR_DELIVERY",
                  "DELIVERED",
                  "EXCEPTION",
                ]
              : ["SHIPPED"];
  return (
    <div className="shipmentEditor">
      <h4>
        {sellerOrder.shipmentStatus
          ? "Update shipping progress"
          : "Add shipment and tracking"}
      </h4>
      <form onSubmit={(event) => void save(event)}>
        <label>
          Delivery status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {nextStatuses.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Carrier
          <input
            required
            maxLength={120}
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            placeholder="e.g. DHL, J&T, local courier"
          />
        </label>
        <label>
          Tracking number
          <input
            maxLength={160}
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
          />
        </label>
        <label>
          Tracking URL
          <input
            type="url"
            maxLength={2000}
            value={trackingUrl}
            onChange={(event) => setTrackingUrl(event.target.value)}
            placeholder="https://carrier.example/track/…"
          />
        </label>
        <label className="shipmentNoteField">
          Buyer update (optional)
          <input
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Parcel accepted at the sorting facility"
          />
        </label>
        <button
          className="primary"
          disabled={
            saving ||
            !carrier.trim() ||
            (!trackingNumber.trim() && !trackingUrl.trim())
          }
        >
          {saving ? "Saving update…" : "Save and notify buyer"}
        </button>
      </form>
      {message && (
        <p
          className={
            message.includes("saved") ? "receiptConfirmedLine" : "notice"
          }
          role={message.includes("saved") ? "status" : "alert"}
        >
          {message}
        </p>
      )}
      {sellerOrder.shipmentUpdates?.length > 0 && (
        <ol
          className="shipmentTimeline sellerShipmentTimeline"
          aria-label="Shipment update history"
        >
          {[...sellerOrder.shipmentUpdates].map((update: any) => (
            <li key={update.id}>
              <span className="shipmentTimelineDot" aria-hidden="true" />
              <div>
                <strong>{update.status.replaceAll("_", " ")}</strong>
                {update.note && <p>{update.note}</p>}
                <small>
                  {update.carrier ?? "Carrier"} ·{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(update.createdAt))}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
