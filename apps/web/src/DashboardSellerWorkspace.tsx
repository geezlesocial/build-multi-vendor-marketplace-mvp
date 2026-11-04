import { LiveRepostTimeline } from "./LiveRepostTimeline.js";
import { SellerAds } from "./SellerAds.js";
import {
  SellerCommissionStatement,
  SellerStoreCurrency,
} from "./SellerStoreCurrency.js";
import { SellerDropshipping } from "./SellerDropshipping.js";
import { SellerLiveStudio } from "./LiveShopping.js";
import { SellerProducts } from "./SellerProducts.js";
import { SellerShipping } from "./SellerShipping.js";
import { SellerStoreIntegrations } from "./SellerStoreIntegrations.js";
import { SupportDesk } from "./SupportDesk.js";
import { Messages } from "./DashboardMessages.js";
import { SellerOrders } from "./SellerOrders.js";
import {
  DashboardMetrics,
  Tabs,
  type SellerData,
  money,
  request,
} from "./DashboardShared.js";

export function SellerDashboard({
  data,
  tab,
  setTab,
  reload,
  currentUserId,
  canUseSeofy,
}: {
  data: SellerData | null;
  tab: string;
  setTab: (value: string) => void;
  reload: () => void;
  currentUserId: string;
  canUseSeofy: boolean;
}) {
  if (!data) return null;
  const groups = [
    { label: "Overview", items: [{ id: "overview", label: "Overview" }] },
    { label: "Catalog", items: [{ id: "products", label: "Products" }] },
    {
      label: "Orders & fulfillment",
      items: [
        { id: "orders", label: "Orders" },
        { id: "shipping", label: "Shipping" },
      ],
    },
    {
      label: "Growth",
      items: [
        { id: "dropshipping", label: "Dropshipping" },
        { id: "ads", label: "Ads" },
      ],
    },
    { label: "Store", items: [{ id: "store", label: "Store" }] },
    {
      label: "Finance",
      items: [
        { id: "currency", label: "Currency" },
        { id: "commission", label: "Commission" },
        { id: "payouts", label: "Payouts" },
      ],
    },
    {
      label: "Tools",
      items: [
        { id: "messages", label: "Messages" },
        { id: "integrations", label: "Integrations" },
        { id: "pos", label: "POS" },
        { id: "live", label: "Live" },
        { id: "profile", label: "Profile" },
      ],
    },
  ];
  return (
    <div className="dashboardWorkspaceLayout">
      <Tabs
        id="seller-dashboard"
        groups={groups}
        active={tab}
        setActive={setTab}
      />
      <div className="dashboardWorkspaceContent">
      {tab === "overview" && (
        <nav className="sellerQuickLinks" aria-label="Seller shortcuts">
          <a href="/seller/plan">
            <small>Account</small>
            <strong>Plan and usage</strong>
          </a>
          <a href="/seller/content">
            <small>Brand experience</small>
            <strong>Content studio</strong>
          </a>
          {canUseSeofy && (
            <a href="/seller/seofy">
              <small>Search visibility</small>
              <strong>SEO-FY audit</strong>
            </a>
          )}
        </nav>
      )}
      {tab === "overview" && (
        <>
          <DashboardMetrics
            label="Seller account summary"
            items={[
              {
                label: "Listings shown",
                value: data.products.length,
                detail: "Manage your catalog",
                href: "/dashboard?mode=seller&tab=products",
                action: "Manage products",
              },
              {
                label: "Seller orders",
                value: data.summary.orderCount,
                detail: "Non-cancelled orders",
                href: "/dashboard?mode=seller&tab=orders",
                action: "Review orders",
              },
              ...(data.summary.grossByCurrency.length
                ? data.summary.grossByCurrency.map((total) => ({
                    label: `Gross sales (${total.currency})`,
                    value: money(total.grossMinor, total.currency),
                    detail: "Recorded seller order totals",
                    href: "/dashboard?mode=seller&tab=orders",
                    action: "Review orders",
                  }))
                : [
                    {
                      label: "Gross sales",
                      value: "No sales yet",
                      detail: "Totals appear after seller orders are recorded",
                    },
                  ]),
            ]}
          />
          <SellerOrders orders={data.orders.slice(0, 5)} reload={reload} />
        </>
      )}
      {tab === "products" && (
        <div className="sellerProductsWorkspace">
          <SellerProducts data={data} reload={reload} request={request} />
        </div>
      )}
      {tab === "orders" && (
        <SellerOrders orders={data.orders} sellerMode reload={reload} />
      )}
      {tab === "shipping" && <SellerShipping />}
      {tab === "dropshipping" && <SellerDropshipping />}
      {tab === "ads" && (
        <>
          <section className="setting sellerProductModule">
            <div>
              <p className="eyebrow">All marketplace accounts</p>
              <h2>Wallet-funded product ads</h2>
              <p>
                Every verified buyer or seller can promote eligible in-stock
                listings. Store Plan entitlements do not gate this
                marketplace-wide ad tool; campaigns are paid from the
                advertiser’s eWallet and reviewed before publishing.
              </p>
              <a className="primary" href="/ads">
                Create or manage product ads
              </a>
            </div>
          </section>
          <SellerAds />
        </>
      )}
      {tab === "currency" && <SellerStoreCurrency />}
      {tab === "commission" && <SellerCommissionStatement />}
      {tab === "integrations" && <SellerStoreIntegrations />}
      {tab === "messages" && (
        <>
          <Messages
            conversations={data.conversations}
            reload={reload}
            currentUserId={currentUserId}
          />
          <SupportDesk mode="seller" />
        </>
      )}
      {tab === "store" && (
        <section className="setting">
          <div>
            <h2>{data.store.name}</h2>
            <p>Public URL: /store/{data.store.slug}</p>
          </div>
          <a href={`/store/${data.store.slug}`}>View store</a>
          <a href="/seller/platform">Edit store settings</a>
          <a href="/seller/themes">Open Themes &amp; Templates Studio</a>
        </section>
      )}
      {tab === "payouts" && (
        <section>
          <h2>Payouts</h2>
          <p className="muted">
            Payouts remain separate from buyer checkout. Full account
            identifiers are never shown.
          </p>
          <div className="table">
            {data.payoutMethods.map((method) => (
              <div className="row" key={method.id}>
                <span>
                  {method.type} · {method.maskedIdentifier}
                </span>
                <span>{method.status}</span>
              </div>
            ))}
            {data.payouts.map((payout) => (
              <div className="row" key={payout.id}>
                <span>{money(payout.amountMinor, payout.currency)}</span>
                <span>{payout.status}</span>
              </div>
            ))}
          </div>
          <a href="/seller/platform">Manage payout methods</a>
        </section>
      )}
      {tab === "pos" && (
        <section className="setting">
          <h2>Cash POS</h2>
          <p>
            POS availability is server-enforced for approved seller/cashier
            accounts.
          </p>
          <a href="/pos">Open POS</a>
        </section>
      )}
      {tab === "live" && <SellerLiveStudio products={data.products} />}
      {tab === "profile" && <LiveRepostTimeline />}
      </div>
    </div>
  );
}
