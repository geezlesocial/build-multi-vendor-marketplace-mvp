import React, { useState } from "react";
import type { SessionUser } from "./session.js";
import { AddressMapPicker } from "./AddressMapPicker.js";
import { LiveRepostTimeline } from "./LiveRepostTimeline.js";
import { LiveShopping } from "./LiveShopping.js";
import { SupportDesk } from "./SupportDesk.js";
import { announceHeaderActivityChange } from "./header-activity-events.js";
import { OrderList } from "./BuyerOrderList.js";
import { Messages } from "./DashboardMessages.js";
import {
  DashboardMetrics,
  Tabs,
  type BuyerData,
  type User,
  money,
  request,
} from "./DashboardShared.js";

export function BuyerDashboard({
  data,
  tab,
  setTab,
  user,
  onUserUpdated,
  cartSyncError,
  reload,
}: {
  data: BuyerData | null;
  tab: string;
  setTab: (value: string) => void;
  user: User;
  onUserUpdated: (user: SessionUser) => void;
  cartSyncError: string;
  reload: () => void;
}) {
  if (!data) return null;
  const groups = [
    {
      label: "Shopping",
      items: [
        { id: "overview", label: "Overview" },
        { id: "cart", label: "Cart" },
      ],
    },
    { label: "Orders", items: [{ id: "orders", label: "Orders" }] },
    {
      label: "Saved items",
      items: [{ id: "favorites", label: "Favorites" }],
    },
    {
      label: "Communications",
      items: [
        { id: "messages", label: "Messages" },
        { id: "notifications", label: "Notifications" },
      ],
    },
    {
      label: "Account",
      items: [
        { id: "profile", label: "Profile" },
        { id: "addresses", label: "Addresses" },
      ],
    },
    { label: "Live", items: [{ id: "live", label: "Live" }] },
  ];
  if (data.affiliate)
    groups.push({
      label: "Growth",
      items: [{ id: "affiliate", label: "Affiliate" }],
    });
  const cartCount = data.cart.items.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  return (
    <div className="dashboardWorkspaceLayout">
      <Tabs
        id="buyer-dashboard"
        groups={groups}
        active={tab}
        setActive={setTab}
      />
      <div className="dashboardWorkspaceContent">
      {cartSyncError && (
        <p className="notice" role="alert">
          Cart summary refresh failed; showing the last saved count.{" "}
          {cartSyncError}{" "}
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event("marketplace:cart-changed"))
            }
          >
            Retry cart summary
          </button>
        </p>
      )}
      {tab === "live" && <LiveShopping />}
      {tab === "overview" && (
        <>
          <DashboardMetrics
            label="Buyer account summary"
            items={[
              {
                label: "Recent orders",
                value: data.orders.length,
                detail: "Track purchases and delivery",
                href: "/dashboard?tab=orders",
                action: "View orders",
              },
              {
                label: "Items in cart",
                value: cartCount,
                detail: "Continue when you are ready",
                href: "/dashboard?tab=cart",
                action: "Review cart",
              },
              {
                label: "Favorites",
                value: data.favorites.length,
                detail: "Products you saved",
                href: "/dashboard?tab=favorites",
                action: "View favorites",
              },
            ]}
          />
          <OrderList
            orders={data.orders.slice(0, 5)}
            reload={reload}
            compact
            onViewAll={() => setTab("orders")}
          />
        </>
      )}
      {tab === "orders" && <OrderList orders={data.orders} reload={reload} />}
      {tab === "cart" && <BuyerCart data={data} />}
      {tab === "favorites" && <Favorites data={data} reload={reload} />}
      {tab === "messages" && (
        <>
          <Messages
            conversations={data.conversations}
            reload={reload}
            currentUserId={user.id}
          />
          <SupportDesk mode="buyer" orders={data.orders} />
        </>
      )}
      {tab === "notifications" && (
        <NotificationList notifications={data.notifications} reload={reload} />
      )}
      {tab === "profile" && (
        <Profile user={user} onUserUpdated={onUserUpdated} reload={reload} />
      )}
      {tab === "addresses" && <Addresses data={data} reload={reload} />}
      {tab === "affiliate" && data.affiliate && (
        <section className="setting">
          <div>
            <h2>Affiliate area</h2>
            <p>Approved affiliate profile: {data.affiliate.referralCode}</p>
          </div>
          <a href="/affiliate">Open affiliate dashboard</a>
        </section>
      )}
      </div>
    </div>
  );
}

function NotificationList({
  notifications,
  reload,
}: {
  notifications: any[];
  reload: () => void;
}) {
  return (
    <section>
      <h2>Notifications</h2>
      {notifications.length === 0 ? (
        <div className="empty">No notifications yet.</div>
      ) : (
        <div className="table">
          {notifications.map((notification) => (
            <div className="row" key={notification.id}>
              <div>
                <strong>{notification.title}</strong>
                <p>{notification.body}</p>
                <small>{notification.readAt ? "Read" : "Unread"}</small>
              </div>
              {!notification.readAt && (
                <button
                  onClick={async () => {
                    await request(
                      `/api/notifications/${notification.id}/read`,
                      { method: "POST", body: "{}" },
                    );
                    announceHeaderActivityChange();
                    reload();
                  }}
                >
                  Mark as read
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BuyerCart({ data }: { data: BuyerData }) {
  const update = async (itemId: string, quantity: number) => {
    try {
      await request(`/api/cart/lines/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity }),
      });
      window.dispatchEvent(new Event("marketplace:cart-changed"));
    } catch (error) {
      alert((error as Error).message);
    }
  };
  return (
    <section>
      <h2>Cart</h2>
      {data.cart.items.length === 0 ? (
        <div className="empty">
          Your cart is empty. <a href="/">Continue shopping</a>.
        </div>
      ) : (
        <div className="table">
          {data.cart.items.map((item) => (
            <div className="row" key={item.id}>
              <span>
                {item.product.name}{item.variant ? ` — ${item.variant.name}` : ""} ·{" "}
                {money(
                  item.variant?.priceMinor ??
                    item.product.salePriceMinor ??
                    item.product.priceMinor,
                  item.product.currency,
                )}
              </span>
              <span>
                <button
                  aria-label={`Decrease ${item.product.name}`}
                  disabled={item.quantity <= 1}
                  onClick={() =>
                    void update(item.id, item.quantity - 1)
                  }
                >
                  −
                </button>{" "}
                {item.quantity}{" "}
                <button
                  aria-label={`Increase ${item.product.name}`}
                  onClick={() =>
                    void update(item.id, item.quantity + 1)
                  }
                >
                  +
                </button>
              </span>
              <button onClick={() => void update(item.id, 0)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <p>
        <a className="primary" href="/">
          Continue shopping
        </a>{" "}
        <a className="primary" href="/checkout">
          Proceed to checkout
        </a>
      </p>
    </section>
  );
}

function Favorites({ data, reload }: { data: BuyerData; reload: () => void }) {
  return (
    <section>
      <h2>Favorites</h2>
      {data.favorites.length === 0 ? (
        <div className="empty">No saved favorites.</div>
      ) : (
        <div className="grid">
          {data.favorites.map((item) => (
            <article className="card" key={item.id}>
              <div className="cardBody">
                <h2>{item.product.name}</h2>
                <p>{item.product.seller?.store?.name ?? "Platform store"}</p>
                <strong>
                  {money(
                    item.product.salePriceMinor ?? item.product.priceMinor,
                    item.product.currency,
                  )}
                </strong>
                <button
                  onClick={async () => {
                    await request(`/api/favorites/${item.productId}`, {
                      method: "DELETE",
                    });
                    announceHeaderActivityChange();
                    reload();
                  }}
                >
                  Remove favorite
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Profile({
  user,
  onUserUpdated,
  reload,
}: {
  user: User;
  onUserUpdated: (user: SessionUser) => void;
  reload: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [message, setMessage] = useState("");
  return (
    <>
      <section className="profileSummary">
        <div className="profileSummaryHeader">
          <h2>Profile and security</h2>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" />
          ) : (
            <span className="avatarFallback" aria-hidden="true">
              {user.name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => Array.from(part)[0]?.toLocaleUpperCase() ?? "")
                .join("")}
            </span>
          )}
        </div>
        <label>
          Display name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted">
          Email: {user.email} · Role: {user.role}
        </p>
        <div className="profileActions">
          <button
            className="primary"
            onClick={async () => {
              const updated = await request<SessionUser>(
                "/api/account/profile",
                { method: "PATCH", body: JSON.stringify({ name }) },
              );
              onUserUpdated(updated);
              setMessage("Profile saved.");
              reload();
            }}
          >
            Save profile
          </button>
          <a href="/settings#profile">Manage your photo and settings</a>
        </div>
        {message && (
          <p role="status" className="muted">
            {message}
          </p>
        )}
      </section>
      <LiveRepostTimeline />
    </>
  );
}

function Addresses({ data, reload }: { data: BuyerData; reload: () => void }) {
  const [form, setForm] = useState({
    label: "Home",
    line1: "",
    city: "",
    region: "",
    postalCode: "",
    country: "US",
  });
  const [coordinates, setCoordinates] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await request("/api/account/addresses", {
        method: "POST",
        body: JSON.stringify({ ...form, ...(coordinates ? coordinates : {}) }),
      });
      setForm({
        label: "Home",
        line1: "",
        city: "",
        region: "",
        postalCode: "",
        country: "US",
      });
      setCoordinates(null);
      setMessage("Address saved.");
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section>
      <h2>Saved addresses</h2>
      <div className="table">
        {data.addresses.map((address) => (
          <div className="row" key={address.id}>
            <span>
              {address.label}: {address.line1}, {address.city}
              {address.latitude != null && address.longitude != null
                ? " · Map pin saved"
                : ""}
            </span>
            <button
              onClick={async () => {
                await request(`/api/account/addresses/${address.id}`, {
                  method: "DELETE",
                });
                reload();
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <form
        className="narrow addressForm"
        onSubmit={(event) => void save(event)}
      >
        <h3>Add address</h3>
        {Object.entries(form).map(([key, value]) => (
          <label key={key}>
            {key === "line1"
              ? "Street address"
              : key === "postalCode"
                ? "Postal code"
                : key[0]!.toUpperCase() + key.slice(1)}
            <input
              required
              value={value}
              onChange={(event) =>
                setForm({ ...form, [key]: event.target.value })
              }
            />
          </label>
        ))}
        <AddressMapPicker value={coordinates} onChange={setCoordinates} />
        <button className="primary" disabled={saving}>
          {saving ? "Saving address…" : "Save address"}
        </button>
        {message && (
          <p role="status" className="muted">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
