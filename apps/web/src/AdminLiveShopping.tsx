import React, { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./live-shopping-api.js";
import type {
  AdminLiveProvider,
  LiveProviderConfiguration,
  LiveReadiness,
  SellerLiveSession,
} from "./live-shopping-types.js";
type AdminLiveSession = SellerLiveSession & {
  seller?: { store?: { name: string } | null };
  reports?: { id: string; reason: string; status: string; createdAt: string }[];
};
type AdminLiveReport = {
  id: string;
  reason: string;
  status: string;
  createdAt: string;
  session: { id: string; title: string; status: string };
  reporter?: { name?: string | null; email: string } | null;
};

export function AdminLiveShopping() {
  const [readiness, setReadiness] = useState<LiveReadiness | null>(null);
  const [providerConfig, setProviderConfig] =
    useState<LiveProviderConfiguration | null>(null);
  const [providerForm, setProviderForm] = useState({
    serverUrl: "",
    apiKey: "",
    apiSecret: "",
    deploymentGateEnabled: false,
    reason: "",
  });
  const [sessions, setSessions] = useState<AdminLiveSession[]>([]);
  const [reports, setReports] = useState<AdminLiveReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const providerFormLoaded = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      const [settings, liveSessions, liveReports, liveProviderConfig] =
        await Promise.all([
          request<{ liveShopping: LiveReadiness }>("/api/admin/settings"),
          request<AdminLiveSession[]>("/api/admin/live-sessions"),
          request<AdminLiveReport[]>("/api/admin/live-reports"),
          request<AdminLiveProvider>("/api/admin/live-provider"),
        ]);
      setReadiness(settings.liveShopping);
      setSessions(liveSessions);
      setReports(liveReports);
      setProviderConfig(liveProviderConfig.configuration);
      if (!providerFormLoaded.current) {
        setProviderForm({
          serverUrl: liveProviderConfig.configuration.serverUrl ?? "",
          apiKey: "",
          apiSecret: "",
          deploymentGateEnabled:
            liveProviderConfig.configuration.deploymentGateEnabled,
          reason: "",
        });
        providerFormLoaded.current = true;
      }
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const visibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load]);

  const adminAction = async (
    path: string,
    options: RequestInit,
    success: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await request(path, options);
      setMessage(success);
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    if (providerSaving) return;
    setProviderSaving(true);
    setMessage("");
    try {
      const result = await request<AdminLiveProvider>(
        "/api/admin/live-provider",
        { method: "PUT", body: JSON.stringify(providerForm) },
      );
      setProviderConfig(result.configuration);
      setReadiness((current) =>
        current
          ? {
              ...current,
              deploymentGate: result.configuration.deploymentGateEnabled,
              readiness: result.readiness,
            }
          : current,
      );
      setProviderForm((current) => ({
        ...current,
        serverUrl: result.configuration.serverUrl ?? current.serverUrl,
        apiKey: "",
        apiSecret: "",
        reason: "",
      }));
      setMessage("LiveKit configuration saved and verified.");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setProviderSaving(false);
    }
  };
  const canEnable = Boolean(
    readiness?.deploymentGate &&
    readiness.readiness.configured &&
    readiness.readiness.healthy,
  );
  return (
    <section className="liveShopping adminLiveShopping">
      <header className="sectionHeading">
        <div>
          <p className="eyebrow">Platform governance</p>
          <h2>Live shopping</h2>
          <p className="muted">
            Review readiness, scheduled sessions, provider status, and viewer
            reports.
          </p>
        </div>
        <span className="ordersLiveBadge">
          <i aria-hidden="true" />
          Refreshes every 10 seconds
        </span>
      </header>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <section className="liveProviderConfig card">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">Streaming integration</p>
            <h3>LiveKit provider configuration</h3>
            <p className="muted">
              Enter the LiveKit project credentials used for real-time
              broadcasts, host tokens, viewer playback, and attendance
              verification.
            </p>
          </div>
          <span
            className={
              providerConfig?.configured
                ? "liveConfigStatus liveConfigStatusReady"
                : "liveConfigStatus"
            }
          >
            {providerConfig?.configured ? "Configured" : "Not configured"}
          </span>
        </div>
        {providerConfig?.source === "DEPLOYMENT_ENVIRONMENT" && (
          <p className="notice">
            The current provider comes from deployment environment variables.
            Saving here creates an encrypted dashboard-managed configuration and
            takes effect without an API restart.
          </p>
        )}
        {providerConfig?.configurationError && (
          <p className="notice" role="alert">
            {providerConfig.configurationError}
          </p>
        )}
        <form className="liveProviderForm" onSubmit={saveProvider}>
          <label>
            LiveKit server URL
            <input
              required
              type="url"
              placeholder="https://your-project.livekit.cloud"
              value={providerForm.serverUrl}
              onChange={(event) =>
                setProviderForm((current) => ({
                  ...current,
                  serverUrl: event.target.value,
                }))
              }
            />
          </label>
          <label>
            LiveKit API key
            <input
              type="text"
              autoComplete="off"
              placeholder={providerConfig?.apiKeyMasked ?? "your-api-key"}
              value={providerForm.apiKey}
              onChange={(event) =>
                setProviderForm((current) => ({
                  ...current,
                  apiKey: event.target.value,
                }))
              }
            />
            <small>Leave blank to keep the currently stored key.</small>
          </label>
          <label>
            LiveKit API secret
            <input
              type="password"
              autoComplete="new-password"
              placeholder={
                providerConfig?.apiSecretConfigured
                  ? "••••••••••••"
                  : "your-api-secret"
              }
              value={providerForm.apiSecret}
              onChange={(event) =>
                setProviderForm((current) => ({
                  ...current,
                  apiSecret: event.target.value,
                }))
              }
            />
            <small>
              Secrets are encrypted at rest and are never returned to the
              browser.
            </small>
          </label>
          <label className="liveProviderCheckbox">
            <input
              type="checkbox"
              checked={providerForm.deploymentGateEnabled}
              onChange={(event) =>
                setProviderForm((current) => ({
                  ...current,
                  deploymentGateEnabled: event.target.checked,
                }))
              }
            />{" "}
            Enable LIVE_SHOPPING_AVAILABLE deployment gate
          </label>
          <label>
            Reason for administrative change
            <input
              required
              minLength={3}
              maxLength={500}
              value={providerForm.reason}
              onChange={(event) =>
                setProviderForm((current) => ({
                  ...current,
                  reason: event.target.value,
                }))
              }
              placeholder="Configured the production LiveKit project"
            />
          </label>
          <button
            type="submit"
            disabled={providerSaving || !providerForm.serverUrl}
          >
            {providerSaving
              ? "Saving and verifying…"
              : "Save and verify LiveKit"}
          </button>
        </form>
        <small className="muted">
          Server URL: {providerConfig?.serverUrl ?? "Not configured"} · API key:{" "}
          {providerConfig?.apiKeyConfigured ? "configured" : "missing"} · API
          secret:{" "}
          {providerConfig?.apiSecretConfigured ? "configured" : "missing"} ·
          Deployment gate:{" "}
          {providerConfig?.deploymentGateEnabled ? "on" : "off"}
        </small>
      </section>
      <section className="liveReadinessPanel">
        <div>
          <strong>
            {readiness?.effectiveEnabled
              ? "Live shopping enabled"
              : "Live shopping safely disabled"}
          </strong>
          <p>{readiness?.reason ?? "Loading live provider readiness…"}</p>
          <small>
            All controls fail closed if the deployment gate, admin switch, or
            provider health check is unavailable.
          </small>
        </div>
        <button
          type="button"
          disabled={busy || (!readiness?.runtimeEnabled && !canEnable)}
          onClick={() =>
            void adminAction(
              "/api/admin/settings",
              {
                method: "PATCH",
                body: JSON.stringify({
                  liveShoppingEnabled: !readiness?.runtimeEnabled,
                  reason:
                    "Updated live-shopping availability in Control Center",
                }),
              },
              readiness?.runtimeEnabled
                ? "Live shopping disabled."
                : "Live shopping enabled.",
            )
          }
        >
          {readiness?.runtimeEnabled
            ? "Disable live shopping"
            : "Enable live shopping"}
        </button>
      </section>
      {!canEnable && readiness && (
        <div className="notice">
          Enable is unavailable: {readiness.reason} No simulated streams or
          credentials are accepted.
        </div>
      )}
      {readiness && (
        <p className="muted">
          Attendance rewards:{" "}
          {readiness.readiness.attendanceVerificationAvailable
            ? "provider-verified playback is available"
            : "disabled until the provider can verify viewer playback server-side"}
          .
        </p>
      )}
      <div className="liveSessionListHeading">
        <h3>Sessions</h3>
        <span>{sessions.length} records</span>
      </div>
      {loading && (
        <div className="empty" role="status">
          Loading live sessions…
        </div>
      )}
      {!loading && sessions.length === 0 && (
        <div className="empty">No live sessions have been created.</div>
      )}
      <div className="liveSellerSessionList">
        {sessions.map((session) => (
          <article className="liveSellerSession card" key={session.id}>
            <header>
              <div>
                <span className="liveStatusPill">
                  {session.status.replaceAll("_", " ")}
                </span>
                <h4>{session.title}</h4>
                <p className="muted">
                  {session.seller?.store?.name ?? "Store"} ·{" "}
                  {session.scheduledAt
                    ? new Date(session.scheduledAt).toLocaleString()
                    : "Not scheduled"}{" "}
                  · {session.products.length} products
                </p>
              </div>
              {!["ENDED", "CANCELLED", "FAILED"].includes(session.status) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Terminate “${session.title}”? This action is audited and the session history is retained.`,
                      )
                    )
                      void adminAction(
                        `/api/admin/live-sessions/${encodeURIComponent(session.id)}/terminate`,
                        { method: "POST", body: "{}" },
                        "Session terminated.",
                      );
                  }}
                >
                  Terminate session
                </button>
              )}
            </header>
            <p>{session.description || "No show description."}</p>
            {session.reports?.length ? (
              <small>
                {
                  session.reports.filter((report) => report.status === "OPEN")
                    .length
                }{" "}
                open report(s)
              </small>
            ) : (
              <small>No reports</small>
            )}
          </article>
        ))}
      </div>
      <div className="liveSessionListHeading">
        <h3>Viewer reports</h3>
        <span>
          {reports.filter((report) => report.status === "OPEN").length} open
        </span>
      </div>
      {reports.length === 0 ? (
        <div className="empty">No viewer reports.</div>
      ) : (
        <div className="liveAdminReports">
          {reports.map((report) => (
            <article className="liveAdminReport card" key={report.id}>
              <div>
                <span className="liveStatusPill">{report.status}</span>
                <h4>{report.session.title}</h4>
                <p>{report.reason}</p>
                <small>
                  {report.reporter?.name ||
                    report.reporter?.email ||
                    "Anonymous"}{" "}
                  · {new Date(report.createdAt).toLocaleString()}
                </small>
              </div>
              {report.status === "OPEN" && (
                <div className="liveSellerSessionActions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void adminAction(
                        `/api/admin/live-reports/${encodeURIComponent(report.id)}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ status: "REVIEWED" }),
                        },
                        "Report marked reviewed.",
                      )
                    }
                  >
                    Mark reviewed
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void adminAction(
                        `/api/admin/live-reports/${encodeURIComponent(report.id)}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ status: "DISMISSED" }),
                        },
                        "Report dismissed.",
                      )
                    }
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
