import React, { useCallback, useEffect, useRef, useState } from "react";
import { ProductTagPicker } from "./LiveProductTagPicker.js";
import { SellerSessionCard } from "./LiveSellerSessionCard.js";
import { request } from "./live-shopping-api.js";
import type {
  LiveProduct,
  LiveReadiness,
  SellerLiveSession,
} from "./live-shopping-types.js";
export function SellerLiveStudio({ products }: { products: LiveProduct[] }) {
  const [sessions, setSessions] = useState<SellerLiveSession[]>([]);
  const [deletedSessions, setDeletedSessions] = useState<SellerLiveSession[]>(
    [],
  );
  const [showDeleted, setShowDeleted] = useState(false);
  const [readiness, setReadiness] = useState<LiveReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [featuredProductId, setFeaturedProductId] = useState("");
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      const [items, deletedItems, liveState] = await Promise.all([
        request<SellerLiveSession[]>("/api/seller/live-sessions"),
        request<SellerLiveSession[]>("/api/seller/live-sessions?view=deleted"),
        request<LiveReadiness>("/api/live-shopping/status"),
      ]);
      setSessions(items);
      setDeletedSessions(deletedItems);
      setReadiness(liveState);
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

  const createSession = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request("/api/seller/live-sessions", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          ...(scheduledAt
            ? { scheduledAt: new Date(scheduledAt).toISOString() }
            : {}),
          productIds,
          ...(featuredProductId ? { featuredProductId } : {}),
        }),
      });
      setTitle("");
      setDescription("");
      setScheduledAt("");
      setProductIds([]);
      setFeaturedProductId("");
      setMessage(
        "Show saved. It will appear publicly after live shopping is enabled and the stream provider is ready.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateSession = async (
    sessionId: string,
    input: { title: string; description: string; scheduledAt: string },
  ) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title: input.title,
            description: input.description,
            scheduledAt: input.scheduledAt
              ? new Date(input.scheduledAt).toISOString()
              : null,
          }),
        },
      );
      setMessage("Show details saved.");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateShopProducts = async (
    sessionId: string,
    input: { productIds: string[]; featuredProductId: string | null },
  ) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(sessionId)}/products`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      setMessage(
        "Live shopping products saved. Existing historical product links were preserved.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cancelSession = async (session: SellerLiveSession) => {
    if (
      saving ||
      !window.confirm(
        `Cancel “${session.title}”? This keeps the session record for audit history.`,
      )
    )
      return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`,
        { method: "POST", body: JSON.stringify({ status: "CANCELLED" }) },
      );
      setMessage("Show cancelled.");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setShowPublished = async (
    session: SellerLiveSession,
    published: boolean,
  ) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`,
        {
          method: "POST",
          body: JSON.stringify({ status: published ? "SCHEDULED" : "DRAFT" }),
        },
      );
      setMessage(
        published
          ? "Show published. Shoppers can see its schedule while live shopping is available."
          : "Show unpublished and returned to drafts. Its schedule and details were kept.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteShow = async (session: SellerLiveSession) => {
    if (
      saving ||
      !window.confirm(
        `Move “${session.title}” to Deleted shows? It will be unpublished and can be restored later.`,
      )
    )
      return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}`,
        { method: "DELETE" },
      );
      setMessage(
        "Show moved to Deleted shows. Any replay is private until the show is restored.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const restoreShow = async (session: SellerLiveSession) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/restore`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setMessage(
        "Show restored. It is not publicly listed until you publish it again.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setReplayPublished = async (
    session: SellerLiveSession,
    published: boolean,
  ) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`,
        { method: "POST", body: JSON.stringify({ published }) },
      );
      setMessage(
        published
          ? "Replay published and now visible in Live Shopping."
          : "Replay is private again.",
      );
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteReplay = async (session: SellerLiveSession) => {
    if (
      saving ||
      !window.confirm(
        `Permanently delete the replay for “${session.title}”? This cannot be undone.`,
      )
    )
      return;
    setSaving(true);
    setMessage("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`,
        { method: "DELETE" },
      );
      setMessage("Replay permanently deleted from recording storage.");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const providerReady = Boolean(readiness?.effectiveEnabled);
  return (
    <section className="liveShopping liveStudio">
      <header className="sectionHeading">
        <div>
          <p className="eyebrow">Seller studio</p>
          <h2>Live shows</h2>
          <p className="muted">
            Prepare a show, schedule it, and attach approved products.
            Publishing and viewer playback require a real, healthy streaming
            provider.
          </p>
        </div>
        <span className="ordersLiveBadge">
          <i aria-hidden="true" />
          Refreshes every 10 seconds
        </span>
      </header>
      {readiness && (
        <div
          className={
            providerReady ? "liveReadiness liveReadinessReady" : "liveReadiness"
          }
        >
          <strong>
            {providerReady
              ? "Streaming is ready"
              : "Publishing is not configured"}
          </strong>
          <span>
            {providerReady
              ? `Provider: ${readiness.readiness.provider ?? "configured"}`
              : readiness.reason}
          </span>
          <small>
            {providerReady
              ? `Create or schedule a show, then start it and allow camera and microphone access. Viewer attendance rewards count during provider-verified playback. ${readiness.recordingAvailable ? "Private replay storage is configured; LiveKit Egress must also be enabled, and you choose whether to publish each replay." : "Replay recording is not configured; live streaming remains available, but shows will not be recorded."}`
              : "Drafts and schedules can be managed now. Starting a broadcast stays unavailable until the platform owner configures and verifies a provider."}
          </small>
        </div>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <form
        className="liveSessionForm"
        onSubmit={(event) => void createSession(event)}
      >
        <div>
          <p className="eyebrow">Plan a show</p>
          <h3>Create a live show</h3>
        </div>
        <label>
          Show title
          <input
            required
            minLength={3}
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={5000}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          Schedule (your local time)
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
          <small>
            Leave blank to save as a draft. Scheduled shows remain private until
            live shopping is enabled.
          </small>
        </label>
        <ProductTagPicker
          products={products}
          productIds={productIds}
          featuredProductId={featuredProductId}
          onProductIdsChange={(next) => {
            setProductIds(next);
            setFeaturedProductId((current) =>
              next.includes(current) ? current : (next[0] ?? ""),
            );
          }}
          onFeaturedProductChange={setFeaturedProductId}
          disabled={saving}
        />
        <button className="primary" disabled={saving}>
          {saving ? "Saving show…" : "Save draft or schedule"}
        </button>
      </form>
      <div className="liveSessionListHeading">
        <h3>{showDeleted ? "Deleted shows" : "Your shows"}</h3>
        <div className="liveShowListActions">
          <span>
            {showDeleted ? deletedSessions.length : sessions.length} total
          </span>
          <button
            type="button"
            onClick={() => setShowDeleted((value) => !value)}
          >
            {showDeleted
              ? "Back to your shows"
              : `Deleted shows (${deletedSessions.length})`}
          </button>
        </div>
      </div>
      {showDeleted && (
        <p className="muted liveArchiveExplanation">
          Deleted shows are hidden from shoppers and their replays are
          unpublished. Restore a show to manage it again; replay files can be
          permanently removed from here.
        </p>
      )}
      {loading && (
        <div className="empty" role="status">
          Loading your shows…
        </div>
      )}
      {!loading && !showDeleted && sessions.length === 0 && (
        <div className="empty">
          No shows yet. Create a draft or add a schedule above.
        </div>
      )}
      {!loading && showDeleted && deletedSessions.length === 0 && (
        <div className="empty">
          Deleted shows appear here and can be restored.
        </div>
      )}
      <div className="liveSellerSessionList">
        {(showDeleted ? deletedSessions : sessions).map((session) => (
          <SellerSessionCard
            key={session.id}
            session={session}
            products={products}
            saving={saving}
            onSave={updateSession}
            onSaveProducts={updateShopProducts}
            onCancel={cancelSession}
            onRefresh={load}
            providerReady={providerReady}
            onReplayChange={setReplayPublished}
            onReplayDelete={deleteReplay}
            onShowPublish={setShowPublished}
            onShowDelete={deleteShow}
            onRestore={restoreShow}
            archived={showDeleted}
          />
        ))}
      </div>
    </section>
  );
}
