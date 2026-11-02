import React, { useEffect, useState } from "react";
import { LiveKitHost } from "./LiveKitHost.js";
import { ProductTagPicker } from "./LiveProductTagPicker.js";
import { request } from "./live-shopping-api.js";
import type { LiveProduct, SellerLiveSession } from "./live-shopping-types.js";
export function SellerSessionCard({
  session,
  products,
  saving,
  onSave,
  onSaveProducts,
  onCancel,
  onRefresh,
  providerReady,
  onReplayChange,
  onReplayDelete,
  onShowPublish,
  onShowDelete,
  onRestore,
  archived,
}: {
  session: SellerLiveSession;
  products: LiveProduct[];
  saving: boolean;
  onSave: (
    sessionId: string,
    input: { title: string; description: string; scheduledAt: string },
  ) => Promise<void>;
  onSaveProducts: (
    sessionId: string,
    input: { productIds: string[]; featuredProductId: string | null },
  ) => Promise<void>;
  onCancel: (session: SellerLiveSession) => Promise<void>;
  onRefresh: () => Promise<void>;
  providerReady: boolean;
  onReplayChange: (
    session: SellerLiveSession,
    published: boolean,
  ) => Promise<void>;
  onReplayDelete: (session: SellerLiveSession) => Promise<void>;
  onShowPublish: (
    session: SellerLiveSession,
    published: boolean,
  ) => Promise<void>;
  onShowDelete: (session: SellerLiveSession) => Promise<void>;
  onRestore: (session: SellerLiveSession) => Promise<void>;
  archived: boolean;
}) {
  const [title, setTitle] = useState(session.title);
  const [description, setDescription] = useState(session.description ?? "");
  const [scheduledAt, setScheduledAt] = useState(
    toLocalDateTime(session.scheduledAt),
  );
  const [shopProductIds, setShopProductIds] = useState<string[]>([]);
  const [featuredShopProductId, setFeaturedShopProductId] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [hostPublished, setHostPublished] = useState(false);
  const [hostError, setHostError] = useState("");
  const shopProductSignature = [...session.products]
    .filter((link) => link.shopFeatured)
    .sort((a, b) => (a.shopSortOrder ?? 0) - (b.shopSortOrder ?? 0))
    .map((link) => `${link.productId},${link.shopPinned ? "1" : "0"}`)
    .join("|");
  useEffect(() => {
    setTitle(session.title);
    setDescription(session.description ?? "");
    setScheduledAt(toLocalDateTime(session.scheduledAt));
  }, [session.id, session.title, session.description, session.scheduledAt]);
  useEffect(() => {
    const serverProducts = shopProductSignature
      .split("|")
      .filter(Boolean)
      .map((entry) => {
        const [productId, featured] = entry.split(",");
        return { productId: productId ?? "", featured: featured === "1" };
      });
    setShopProductIds(serverProducts.map((link) => link.productId));
    setFeaturedShopProductId(
      serverProducts.find((link) => link.featured)?.productId ??
        serverProducts[0]?.productId ??
        "",
    );
  }, [session.id, shopProductSignature]);
  const editable =
    !archived && (session.status === "DRAFT" || session.status === "SCHEDULED");
  const canManageShop =
    !archived &&
    ["DRAFT", "SCHEDULED", "STARTING", "LIVE", "PAUSED"].includes(
      session.status,
    );
  const canDelete =
    !session.replayDeletionPending &&
    !["STARTING", "LIVE", "PAUSED"].includes(session.status) &&
    !["STARTING", "RECORDING", "PROCESSING"].includes(
      session.recordingStatus ?? "NOT_CONFIGURED",
    );
  const canPublish = Boolean(
    session.scheduledAt && new Date(session.scheduledAt).getTime() > Date.now(),
  );
  const transition = async (status: "STARTING" | "LIVE" | "ENDED") => {
    if (broadcastBusy) return;
    setBroadcastBusy(true);
    setHostError("");
    try {
      await request(
        `/api/seller/live-sessions/${encodeURIComponent(session.id)}/transition`,
        { method: "POST", body: JSON.stringify({ status }) },
      );
      await onRefresh();
    } catch (reason) {
      setHostError((reason as Error).message);
    } finally {
      setBroadcastBusy(false);
    }
  };
  return (
    <article className="liveSellerSession card">
      <header>
        <div>
          <span className="liveStatusPill">
            {archived ? "DELETED" : session.status.replaceAll("_", " ")}
          </span>
          <h4>{session.title}</h4>
          <p className="muted">
            {session.scheduledAt
              ? new Date(session.scheduledAt).toLocaleString()
              : "Not scheduled"}{" "}
            · {session.products.length} linked products
            {archived && session.deletedAt
              ? ` · Deleted ${new Date(session.deletedAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div className="liveSellerSessionActions">
          {archived ? (
            <button
              type="button"
              disabled={saving || broadcastBusy}
              onClick={() => void onRestore(session)}
            >
              Restore show
            </button>
          ) : (
            <>
              {session.status === "DRAFT" && (
                <button
                  type="button"
                  disabled={saving || broadcastBusy || !canPublish}
                  title={
                    !canPublish
                      ? "Add a future schedule in Edit show details before publishing."
                      : undefined
                  }
                  onClick={() => void onShowPublish(session, true)}
                >
                  Publish show
                </button>
              )}
              {session.status === "SCHEDULED" && (
                <>
                  <button
                    type="button"
                    disabled={saving || broadcastBusy}
                    onClick={() => void onShowPublish(session, false)}
                  >
                    Unpublish show
                  </button>
                  <button
                    type="button"
                    disabled={saving || broadcastBusy || !providerReady}
                    onClick={() => void transition("STARTING")}
                  >
                    {broadcastBusy ? "Starting…" : "Start broadcast"}
                  </button>
                </>
              )}
              {session.status === "STARTING" && (
                <button
                  type="button"
                  disabled={saving || broadcastBusy || !hostPublished}
                  onClick={() => void transition("LIVE")}
                >
                  {broadcastBusy ? "Going live…" : "Go live"}
                </button>
              )}
              {session.status === "LIVE" && (
                <button
                  type="button"
                  disabled={saving || broadcastBusy}
                  onClick={() => void transition("ENDED")}
                >
                  {broadcastBusy ? "Ending…" : "End broadcast"}
                </button>
              )}
              {session.status === "ENDED" &&
                session.recordingStatus === "READY" && (
                  <>
                    <button
                      type="button"
                      disabled={saving || broadcastBusy}
                      onClick={() =>
                        void onReplayChange(session, !session.replayPublishedAt)
                      }
                    >
                      {session.replayPublishedAt
                        ? "Unpublish replay"
                        : "Publish replay"}
                    </button>
                    {!session.replayPublishedAt && (
                      <button
                        type="button"
                        disabled={saving || broadcastBusy}
                        onClick={() => void onReplayDelete(session)}
                      >
                        Delete replay
                      </button>
                    )}
                  </>
                )}
              {editable && (
                <button
                  type="button"
                  disabled={saving || broadcastBusy}
                  onClick={() => void onCancel(session)}
                >
                  Cancel show
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className="liveDeleteShowButton"
                  disabled={saving || broadcastBusy}
                  onClick={() => void onShowDelete(session)}
                >
                  Delete show
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {!!session.products.length && (
        <ul className="liveLinkedProducts">
          {session.products.map((link) => (
            <li key={link.productId}>
              {link.shopFeatured
                ? "Shop shelf: "
                : link.featured
                  ? "Historical feature: "
                  : "Historical link: "}
              {link.product?.name ?? "Product"}
            </li>
          ))}
        </ul>
      )}
      {canManageShop && (
        <details className="liveSessionEdit liveSessionShopEdit">
          <summary>
            Manage featured products · {shopProductIds.length}/6
          </summary>
          <ProductTagPicker
            products={products}
            productIds={shopProductIds}
            featuredProductId={featuredShopProductId}
            onProductIdsChange={(next) => {
              setShopProductIds(next);
              setFeaturedShopProductId((current) =>
                next.includes(current) ? current : (next[0] ?? ""),
              );
            }}
            onFeaturedProductChange={setFeaturedShopProductId}
            disabled={saving || broadcastBusy}
          />
          <button
            type="button"
            disabled={saving || broadcastBusy}
            onClick={() =>
              void onSaveProducts(session.id, {
                productIds: shopProductIds,
                featuredProductId: featuredShopProductId || null,
              })
            }
          >
            Save featured products
          </button>
        </details>
      )}
      {["STARTING", "LIVE", "PAUSED"].includes(session.status) && (
        <>
          <LiveKitHost
            sessionId={session.id}
            onPublished={setHostPublished}
            onError={setHostError}
          />
          <small className="muted">
            {session.status === "STARTING"
              ? hostPublished
                ? "Camera and microphone are ready. You can go live."
                : "Allow camera and microphone access, then wait for the preview."
              : "Your live broadcast is connected."}
          </small>
        </>
      )}
      {!archived && ["STARTING", "LIVE", "PAUSED"].includes(session.status) && (
        <p className="muted">
          An active broadcast stays visible while it is on air. End the
          broadcast to take it offline; you can unpublish its replay after
          recording finishes.
        </p>
      )}
      {session.status === "ENDED" &&
        session.recordingStatus &&
        session.recordingStatus !== "NOT_CONFIGURED" && (
          <div className="liveReplayStatus" role="status">
            <strong>
              Replay:{" "}
              {session.replayDeletionPending
                ? "deletion pending"
                : session.recordingStatus.toLowerCase()}
            </strong>
            {session.recordingStatus === "READY" ? (
              <>
                <p>
                  {session.replayPublishedAt
                    ? "This replay is published and visible to shoppers."
                    : "This replay is private. Publish it when you are ready."}
                </p>
                <video
                  className="liveReplayPlayer"
                  controls
                  preload="metadata"
                  playsInline
                  src={`/api/seller/live-sessions/${encodeURIComponent(session.id)}/replay`}
                >
                  Your browser does not support replay video.
                </video>
                {archived && (
                  <button
                    type="button"
                    disabled={saving || broadcastBusy}
                    onClick={() => void onReplayDelete(session)}
                  >
                    Permanently delete replay file
                  </button>
                )}
              </>
            ) : session.replayDeletionPending ? (
              <>
                <p>
                  The replay file is awaiting deletion. If the previous storage
                  attempt failed, retry it here.
                </p>
                <button
                  type="button"
                  disabled={saving || broadcastBusy}
                  onClick={() => void onReplayDelete(session)}
                >
                  Retry replay deletion
                </button>
              </>
            ) : (
              <p>
                {session.recordingStatus === "FAILED"
                  ? "The recording could not be completed. Live streaming was not affected."
                  : "The recording is being finalized in private storage. This card will update automatically."}
              </p>
            )}
          </div>
        )}
      {session.status === "ENDED" &&
        session.recordingStatus === "NOT_CONFIGURED" && (
          <p className="muted">
            Replay recording was not configured when this show went live, so
            there is no recording to publish.
          </p>
        )}
      {hostError && (
        <p className="notice" role="alert">
          {hostError}
        </p>
      )}
      {editable && (
        <details className="liveSessionEdit">
          <summary>Edit show details</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onSave(session.id, { title, description, scheduledAt });
            }}
          >
            <label>
              Title
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
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label>
              Schedule
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
              <small>
                Set a date to schedule the show, or clear it to keep a draft.
              </small>
            </label>
            <button disabled={saving}>Save show details</button>
          </form>
        </details>
      )}
      {!archived && (
        <button
          className="liveRefreshButton"
          type="button"
          onClick={() => void onRefresh()}
        >
          Refresh status
        </button>
      )}
    </article>
  );
}

function toLocalDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
