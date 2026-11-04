import { useCallback, useEffect, useMemo, useState } from "react";
import "./SellerSeoFy.css";

type Suggestion = {
  id: string;
  field: "SEO_TITLE" | "SEO_DESCRIPTION";
  currentValue: string | null;
  recommendedValue: string;
  rationale: string;
  evidence: string;
  status: "PENDING" | "APPLIED" | "STALE";
};
type Finding = {
  key: string;
  severity: "INFO" | "WARNING";
  title: string;
  detail: string;
};
type Audit = {
  id: string;
  targetType: "STORE" | "PRODUCT";
  targetId: string;
  status: string;
  aiStatus:
    "NOT_CONFIGURED" | "USED" | "INVALID_RESPONSE" | "BUSY" | "UNAVAILABLE";
  learningUsed: boolean;
  findings: Finding[];
  suggestions: Suggestion[];
  createdAt: string;
};
type Product = {
  id: string;
  name: string;
  slug: string;
  seoTitle: string | null;
  seoDescription: string | null;
};
type Data = {
  store: { id: string; name: string; slug: string };
  entitlement: { enabled: boolean; learningOptIn: boolean };
  learningAvailable: boolean;
  products: Product[];
  audits: Audit[];
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie
    .split("; ")
    .find((value) => value.startsWith("marketplace_csrf="))
    ?.split("=")[1];
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "SEO-FY request failed.");
  return body as T;
}

const aiStatusText: Record<Audit["aiStatus"], string> = {
  USED: "Local Jima generated these drafts.",
  NOT_CONFIGURED:
    "Local Jima is not enabled; deterministic guidance is shown instead.",
  INVALID_RESPONSE:
    "Jima returned an unusable response; safe deterministic guidance is shown instead.",
  BUSY: "Jima is at its local capacity; safe deterministic guidance is shown instead.",
  UNAVAILABLE:
    "The local Jima runtime is unavailable; safe deterministic guidance is shown instead.",
};

export function SellerSeoFy() {
  const [data, setData] = useState<Data | null>(null);
  const [target, setTarget] = useState("STORE");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(
    async () => setData(await api<Data>("/api/seller/seofy")),
    [],
  );
  useEffect(() => {
    void load().catch((reason) => setError((reason as Error).message));
  }, [load]);
  const currentAudit = data?.audits[0] ?? null;
  const selectedSuggestions = useMemo(
    () =>
      currentAudit?.suggestions.filter((item) => selected.includes(item.id)) ??
      [],
    [currentAudit, selected],
  );

  const runAudit = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    setSelected([]);
    try {
      const body =
        target === "STORE"
          ? { targetType: "STORE" }
          : { targetType: "PRODUCT", targetId: target };
      await api<Audit>("/api/seller/seofy/audits", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await load();
      setSelected([]);
      setNotice(
        "Audit complete. Review each optional draft before choosing whether to apply it.",
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applySelected = async () => {
    if (!currentAudit || !selected.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ message: string }>(
        `/api/seller/seofy/audits/${encodeURIComponent(currentAudit.id)}/apply`,
        { method: "POST", body: JSON.stringify({ suggestionIds: selected }) },
      );
      setNotice(result.message);
      setSelected([]);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const setLearning = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/seller/seofy/learning", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      await load();
      setNotice(
        enabled
          ? "Privacy-safe aggregate learning is on."
          : "Aggregate learning is off. Buyer preferences were not changed.",
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data)
    return (
      <main className="page seofyPage">
        <p className="eyebrow">Seller growth</p>
        <h1>SEO-FY</h1>
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : (
          <p role="status">Loading your Store SEO workspace…</p>
        )}
      </main>
    );

  return (
    <main className="page seofyPage">
      <header className="seofyHero">
        <div>
          <p className="eyebrow">Seller growth · Jima-powered</p>
          <h1>SEO-FY</h1>
          <p>
            Review practical Store and product search-readiness checks. Drafts
            never publish themselves, and better rankings or sales are not
            guaranteed.
          </p>
        </div>
        <span className="seofyBadge">
          {data.entitlement.enabled
            ? "Paid plan active"
            : "Plan access required"}
        </span>
      </header>
      {!data.entitlement.enabled && (
        <section className="seofyGate" aria-labelledby="seofy-gate-title">
          <div>
            <h2 id="seofy-gate-title">
              Available with an eligible paid Store plan
            </h2>
            <p>
              SEO-FY requires an active, paid subscription and a plan that
              includes the feature. Existing free and legacy Stores keep their
              current settings.
            </p>
          </div>
          <a className="primary" href="/seller/plan">
            Review Store plan
          </a>
        </section>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      <section className="seofyWorkspace" aria-labelledby="seofy-run-title">
        <div className="seofySectionHeading">
          <div>
            <p className="eyebrow">Audit workspace</p>
            <h2 id="seofy-run-title">Choose what to review</h2>
          </div>
          <span>{data.store.name}</span>
        </div>
        <div className="seofyRunRow">
          <label>
            Audit target
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={!data.entitlement.enabled || busy}
            >
              <option value="STORE">Store · {data.store.name}</option>
              {data.products.map((product) => (
                <option value={product.id} key={product.id}>
                  Product · {product.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            type="button"
            onClick={() => void runAudit()}
            disabled={!data.entitlement.enabled || busy}
          >
            {busy ? "Working…" : "Run SEO audit"}
          </button>
        </div>
        <p className="muted">
          Only your public Store details, approved products, and approved
          product image-alt coverage are analyzed. Buyer, order, payment, and
          account data are excluded.
        </p>
      </section>
      {currentAudit && (
        <section
          className="seofyWorkspace"
          aria-labelledby="seofy-results-title"
        >
          <div className="seofySectionHeading">
            <div>
              <p className="eyebrow">
                {new Date(currentAudit.createdAt).toLocaleString()}
              </p>
              <h2 id="seofy-results-title">Audit findings</h2>
            </div>
            <span
              className={`seofyStatus seofyStatus--${currentAudit.status.toLowerCase()}`}
            >
              {currentAudit.status.replaceAll("_", " ")}
            </span>
          </div>
          <p className="seofyAiStatus" role="status">
            {aiStatusText[currentAudit.aiStatus]}
          </p>
          {currentAudit.learningUsed && (
            <p className="muted">
              This audit used only category-level aggregates from consented
              personalization activity meeting the minimum cohort threshold.
            </p>
          )}
          <div className="seofyFindings">
            {currentAudit.findings.map((finding) => (
              <article className="seofyFinding" key={finding.key}>
                <span
                  className={`seofySeverity seofySeverity--${finding.severity.toLowerCase()}`}
                >
                  {finding.severity}
                </span>
                <div>
                  <h3>{finding.title}</h3>
                  <p>{finding.detail}</p>
                </div>
              </article>
            ))}
          </div>
          <h3>Suggested metadata · approval required</h3>
          <p className="muted">
            Select the drafts you want. SEO-FY can update only the search title
            and description; it cannot change price, stock, listing status,
            slug, Store design, shipping, payment, or permissions.
          </p>
          {!currentAudit.suggestions.length && (
            <p className="empty">
              No metadata draft is needed from the available information.
            </p>
          )}
          <div className="seofySuggestions">
            {currentAudit.suggestions.map((suggestion) => (
              <label className="seofySuggestion" key={suggestion.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(suggestion.id)}
                  disabled={
                    busy ||
                    !data.entitlement.enabled ||
                    suggestion.status !== "PENDING"
                  }
                  onChange={(event) =>
                    setSelected((value) =>
                      event.target.checked
                        ? [...value, suggestion.id]
                        : value.filter((id) => id !== suggestion.id),
                    )
                  }
                />
                <span>
                  <strong>
                    {suggestion.field === "SEO_TITLE"
                      ? "Search title"
                      : "Search description"}{" "}
                    · {suggestion.status.toLowerCase()}
                  </strong>
                  <small>Current: {suggestion.currentValue || "Not set"}</small>
                  <span className="seofyDraft">
                    {suggestion.recommendedValue}
                  </span>
                  <small>
                    {suggestion.rationale} {suggestion.evidence}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {!!currentAudit.suggestions.length && (
            <button
              className="primary"
              type="button"
              disabled={
                busy ||
                !data.entitlement.enabled ||
                selectedSuggestions.length === 0
              }
              onClick={() => void applySelected()}
            >
              {busy
                ? "Applying…"
                : `Approve & apply selected (${selectedSuggestions.length})`}
            </button>
          )}
        </section>
      )}
      <section className="seofyPrivacy">
        <div>
          <p className="eyebrow">Optional, privacy-safe learning</p>
          <h2>Improve future local guidance</h2>
          <p>
            Off by default. If enabled, and the platform's Jima personalization
            switch is also on, Jima may receive category-level activity
            aggregates only from buyers who opted into personalization, with at
            least 20 distinct consenting users per category and a 90-day window.
            No identities, raw activity history, or order data are sent. This
            does not train a model or apply changes automatically.
          </p>
          {!data.learningAvailable && (
            <p className="muted" role="status">
              Aggregate learning is currently unavailable because local Jima or
              its platform personalization setting is disabled.
            </p>
          )}
        </div>
        <label className="seofyToggle">
          <input
            type="checkbox"
            checked={data.entitlement.learningOptIn}
            disabled={busy || !data.entitlement.enabled}
            onChange={(event) => void setLearning(event.target.checked)}
          />
          <span>Allow privacy-safe aggregate learning</span>
        </label>
      </section>
      <section className="seofyWorkspace">
        <div className="seofySectionHeading">
          <div>
            <p className="eyebrow">History</p>
            <h2>Recent audits</h2>
          </div>
        </div>
        {data.audits.length ? (
          <div className="seofyHistory">
            {data.audits.map((audit) => (
              <article key={audit.id}>
                <div>
                  <strong>
                    {audit.targetType === "STORE"
                      ? data.store.name
                      : (data.products.find(
                          (product) => product.id === audit.targetId,
                        )?.name ?? "Product")}
                  </strong>
                  <small>
                    {new Date(audit.createdAt).toLocaleString()} ·{" "}
                    {aiStatusText[audit.aiStatus]}
                  </small>
                </div>
                <span
                  className={`seofyStatus seofyStatus--${audit.status.toLowerCase()}`}
                >
                  {audit.status.replaceAll("_", " ")}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">Your completed audits will appear here.</p>
        )}
      </section>
    </main>
  );
}
