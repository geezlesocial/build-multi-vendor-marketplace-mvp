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

export function Tabs({
  items,
  active,
  setActive,
  id,
}: {
  items: string[];
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
          {items.map((item) => (
            <option key={item} value={item}>
              {item[0].toUpperCase() + item.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <nav className="dashboardTabs" aria-label="Dashboard sections">
        {items.map((item) => (
          <button
            type="button"
            key={item}
            className={active === item ? "primary" : ""}
            aria-current={active === item ? "page" : undefined}
            onClick={() => setActive(item)}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
    </>
  );
}
