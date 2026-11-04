import { useCallback, useEffect, useState } from "react";

type Metrics = {
  windowDays: number;
  audits: number;
  localAiAudits: number;
  appliedSuggestions: number;
  optedInStores: number;
  lastAuditAt: string | null;
  sellerDetailsExposed: false;
};

async function getMetrics() {
  const response = await fetch("/api/admin/seofy/metrics", {
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error ?? "SEO-FY metrics are unavailable.");
  return body as Metrics;
}

export function SeoFyAdminSummary() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setError("");
    void getMetrics()
      .then(setMetrics)
      .catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <section aria-labelledby="seofy-admin-title">
      <h3 id="seofy-admin-title">SEO-FY operations</h3>
      <p className="muted">
        Aggregate service-health metrics only. This view contains no Store
        names, seller identities, buyer activity, or report contents. Manage
        feature availability through Store plan entitlements.
      </p>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : metrics ? (
        <>
          <div className="adminMetricGrid">
            <article className="card cardBody">
              <strong>{metrics.audits}</strong>
              <span>Audits · last {metrics.windowDays} days</span>
            </article>
            <article className="card cardBody">
              <strong>{metrics.localAiAudits}</strong>
              <span>Completed with local Jima</span>
            </article>
            <article className="card cardBody">
              <strong>{metrics.appliedSuggestions}</strong>
              <span>Seller-approved updates</span>
            </article>
            <article className="card cardBody">
              <strong>{metrics.optedInStores}</strong>
              <span>Stores with saved learning opt-in</span>
            </article>
          </div>
          <p className="muted">
            Last recorded audit:{" "}
            {metrics.lastAuditAt
              ? new Date(metrics.lastAuditAt).toLocaleString()
              : "none"}{" "}
            · Seller details exposed: no
          </p>
        </>
      ) : (
        <p role="status">Loading aggregate metrics…</p>
      )}
      <button type="button" onClick={refresh}>
        Refresh SEO-FY metrics
      </button>
    </section>
  );
}
