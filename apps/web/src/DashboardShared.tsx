import { formatMinor } from "./money.js";

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  sellerId?: string;
  avatarUrl?: string;
};

export type Access = {
  buyer: boolean;
  seller: boolean;
  affiliateEligible: boolean;
  sellerApplication: {
    status: string;
    reason?: string | null;
    store?: { name: string; slug: string } | null;
  } | null;
};

export type BuyerData = {
  orders: any[];
  cart: { items: any[] };
  favorites: any[];
  conversations: any[];
  notifications: any[];
  addresses: any[];
  affiliate: any | null;
};

export type SellerData = {
  store: any;
  entitlements: { seofyEnabled: boolean };
  summary: {
    orderCount: number;
    grossByCurrency: { currency: string; grossMinor: number }[];
  };
  products: any[];
  orders: any[];
  conversations: any[];
  payoutMethods: any[];
  payouts: any[];
  live: { effectiveEnabled: boolean; deploymentGate: boolean; reason: string };
};

export const money = (minor: number, currency = "USD") =>
  formatMinor(minor, currency);

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export type DashboardNavGroup = {
  label: string;
  items: { id: string; label: string }[];
};

export function Tabs({
  groups,
  active,
  setActive,
  id,
}: {
  groups: DashboardNavGroup[];
  active: string;
  setActive: (value: string) => void;
  id: string;
}) {
  return (
    <>
      <label className="dashboardMobileJump" htmlFor={`${id}-section-jump`}>
        <span>Dashboard section</span>
        <select
          id={`${id}-section-jump`}
          value={active}
          onChange={(event) => setActive(event.target.value)}
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <nav className="dashboardTabs dashboardNav" aria-label="Dashboard sections">
        {groups.map((group) => (
          <div
            className="dashboardNavGroup"
            key={group.label}
            role="group"
            aria-label={group.label}
          >
            <span className="dashboardNavGroupLabel" aria-hidden="true">
              {group.label}
            </span>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={active === item.id ? "primary" : ""}
                aria-current={active === item.id ? "page" : undefined}
                onClick={() => setActive(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}

export type DashboardMetric = {
  label: string;
  value: string | number;
  detail: string;
  href?: string;
  action?: string;
};

export function DashboardMetrics({
  label,
  items,
}: {
  label: string;
  items: DashboardMetric[];
}) {
  return (
    <section className="dashboardMetrics" aria-label={label}>
      {items.map((item) => {
        const content = (
          <>
            <span className="dashboardMetricLabel">{item.label}</span>
            <strong className="dashboardMetricValue">{item.value}</strong>
            <span className="dashboardMetricDetail">{item.detail}</span>
            {item.href && (
              <span className="dashboardMetricAction">
                {item.action ?? "Open"} <span aria-hidden="true">→</span>
              </span>
            )}
          </>
        );
        return item.href ? (
          <a className="dashboardMetric" href={item.href} key={item.label}>
            {content}
          </a>
        ) : (
          <article className="dashboardMetric" key={item.label}>
            {content}
          </article>
        );
      })}
    </section>
  );
}
