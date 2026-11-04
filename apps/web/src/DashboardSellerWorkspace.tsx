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
import { Tabs, type SellerData, money, request } from "./DashboardShared.js";

export function SellerDashboard({
  data,
  tab,
  setTab,
  reload,
  currentUserId,
}: {
  data: SellerData | null;
  tab: string;
  setTab: (value: string) => void;
  reload: () => void;
  currentUserId: string;
}) {
  if (!data) return null;
  const tabs = [
    "overview",
    "products",
    "orders",
    "shipping",
    "dropshipping",
    "ads",
    "messages",
    "store",
    "currency",
    "commission",
    "integrations",
    "payouts",
    "pos",
    "live",
    "profile",
  ];
  return (
    <>
      <Tabs
        id="seller-dashboard"
        items={tabs}
        active={tab}
        setActive={setTab}
      />
      <nav className="sellerQuickLinks" aria-label="Store tools">
        <a href="/seller/plan">
          <small>Account</small>
          <strong>Plan and usage</strong>
        </a>
        <a href="/seller/content">
          <small>Brand experience</small>
          <strong>Content studio</strong>
        </a>
        <a href="/seller/seofy">
          <small>Search visibility</small>
          <strong>SEO-FY audit</strong>
        </a>
        <a href="/dashboard?mode=seller&amp;tab=ads">
          <small>Marketing</small>
          <strong>Ads &amp; growth</strong>
        </a>
        <a href="/seller/currency">
          <small>Finance</small>
          <strong>Store currency</strong>
        </a>
      </nav>
      {tab === "overview" && (
        <>
          <div className="heroPills">
            <span>{data.products.length} products</span>
            <span>{data.summary.orderCount} orders</span>
            {data.summary.grossByCurrency.length ? (
              data.summary.grossByCurrency.map((total) => (
                <span key={total.currency}>
                  Gross sales ({total.currency}):{" "}
                  {money(total.grossMinor, total.currency)}
                </span>
              ))
            ) : (
              <span>No sales yet</span>
            )}
          </div>
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
    </>
  );
}
