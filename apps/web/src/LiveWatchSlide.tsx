import React, { useCallback, useEffect, useRef, useState } from "react";
import { formatMinor } from "./money.js";
import { LiveSocialActions } from "./LiveSocialActions.js";
import { LiveShoppableProductDialog } from "./LiveShoppableProductDialog.js";
import { LiveKitViewer } from "./LiveKitViewer.js";
import { request } from "./live-shopping-api.js";
import type { LiveSession } from "./live-shopping-types.js";

type Attendance = {
  attendance: {
    eligibleDurationSeconds: number;
    rewardedAt: string | null;
  } | null;
  rewardThresholdSeconds: number;
};
type LiveReaction = "LIKE" | "LOVE" | "HAPPY" | "CONGRATS" | "SMILE";
type Engagement = {
  viewCount: number;
  viewersNow: number | null;
  reactions: Record<LiveReaction, number>;
  myReaction: LiveReaction | null;
};
const emptyReactions: Record<LiveReaction, number> = {
  LIKE: 0,
  LOVE: 0,
  HAPPY: 0,
  CONGRATS: 0,
  SMILE: 0,
};

const reactionOptions = [
  { key: "LIKE", label: "Like", emoji: "👍" },
  { key: "LOVE", label: "Love", emoji: "❤️" },
  { key: "HAPPY", label: "Happy", emoji: "😊" },
  { key: "CONGRATS", label: "Congrats", emoji: "🎉" },
  { key: "SMILE", label: "Smile", emoji: "😄" },
] as const;

export function LiveWatchSlide({
  session,
  active,
  canEarn,
  canReact,
}: {
  session: LiveSession;
  active: boolean;
  canEarn: boolean;
  canReact: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const heartbeatQueue = useRef<Promise<void>>(Promise.resolve());
  const viewed = useRef(false);
  const [liveSession, setLiveSession] = useState(session);
  const [playing, setPlaying] = useState(false);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [message, setMessage] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(
    null,
  );
  const [reactionPending, setReactionPending] = useState(false);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const closeProductDialog = useCallback(() => setSelectedProductId(null), []);
  const duration = attendance?.attendance?.eligibleDurationSeconds ?? 0;
  const threshold = attendance?.rewardThresholdSeconds ?? 300;
  const rewarded = Boolean(attendance?.attendance?.rewardedAt);

  useEffect(() => {
    setLiveSession(session);
  }, [session]);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    let pending = false;
    const refreshProducts = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const current = await request<LiveSession>(
          `/api/live-sessions/${encodeURIComponent(session.id)}`,
        );
        if (!mounted || !current.products) return;
        setLiveSession((previous) =>
          JSON.stringify(previous.products) === JSON.stringify(current.products)
            ? previous
            : { ...previous, products: current.products },
        );
      } catch {
        /* The initial shelf remains usable when a background refresh fails. */
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void refreshProducts(), 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshProducts();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [active, session.id]);

  const heartbeat = useCallback(
    (isPlaying: boolean) => {
      if (!canEarn) return;
      heartbeatQueue.current = heartbeatQueue.current.then(async () => {
        try {
          const result = await request<{
            eligibleDurationSeconds: number;
            rewardThresholdSeconds: number;
            rewarded: boolean;
          }>(
            `/api/live-sessions/${encodeURIComponent(session.id)}/attendance/heartbeat`,
            { method: "POST", body: JSON.stringify({ playing: isPlaying }) },
          );
          setAttendance((current) => ({
            attendance: {
              eligibleDurationSeconds: result.eligibleDurationSeconds,
              rewardedAt: result.rewarded
                ? new Date().toISOString()
                : (current?.attendance?.rewardedAt ?? null),
            },
            rewardThresholdSeconds: result.rewardThresholdSeconds,
          }));
        } catch {
          /* Attendance errors should not interrupt watching. */
        }
      });
    },
    [canEarn, session.id],
  );

  const refreshEngagement = useCallback(async () => {
    try {
      const value = await request<Engagement>(
        `/api/live-sessions/${encodeURIComponent(session.id)}/engagement`,
      );
      setEngagement((current) => ({
        ...value,
        viewCount: Math.max(value.viewCount, current?.viewCount ?? 0),
      }));
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, [session.id]);

  const updateReactionCounts = useCallback((event: Event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        counts?: Partial<Record<LiveReaction, number>>;
      };
      if (!payload.counts) return;
      setEngagement((current) => ({
        viewCount: current?.viewCount ?? 0,
        viewersNow: current?.viewersNow ?? null,
        reactions: {
          ...emptyReactions,
          ...current?.reactions,
          ...payload.counts,
        },
        myReaction: current?.myReaction ?? null,
      }));
    } catch {
      /* Ignore malformed event data; the regular status poll remains available. */
    }
  }, []);

  useEffect(() => {
    if (!active || document.visibilityState !== "visible") return undefined;
    void refreshEngagement();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshEngagement();
    }, 10_000);
    const events = new EventSource(
      `/api/live-sessions/${encodeURIComponent(session.id)}/engagement/events`,
      { withCredentials: true },
    );
    events.addEventListener("engagement", updateReactionCounts);
    events.onopen = () => {
      if (document.visibilityState === "visible") void refreshEngagement();
    };
    return () => {
      window.clearInterval(timer);
      events.removeEventListener("engagement", updateReactionCounts);
      events.close();
    };
  }, [active, refreshEngagement, session.id, updateReactionCounts]);

  useEffect(() => {
    if (
      !active ||
      !playing ||
      document.visibilityState !== "visible" ||
      viewed.current
    )
      return undefined;
    let current = true;
    void request<{ viewCount: number }>(
      `/api/live-sessions/${encodeURIComponent(session.id)}/view`,
      { method: "POST", body: "{}" },
    )
      .then((result) => {
        if (!current) return;
        viewed.current = true;
        setEngagement((value) => ({
          viewCount: Math.max(result.viewCount, value?.viewCount ?? 0),
          viewersNow: value?.viewersNow ?? null,
          reactions: value?.reactions ?? emptyReactions,
          myReaction: value?.myReaction ?? null,
        }));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active, playing, session.id]);

  useEffect(() => {
    let current = true;
    if (!active || !canEarn) return undefined;
    void request<Attendance>(
      `/api/live-sessions/${encodeURIComponent(session.id)}/attendance`,
    )
      .then((value) => {
        if (current) setAttendance(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active, canEarn, session.id]);

  useEffect(() => {
    const player = video.current;
    if (!active || !playing || !canEarn || !player) return undefined;
    let previousTime = player.currentTime;
    const tick = () => {
      const progressed =
        document.visibilityState === "visible" &&
        !player.paused &&
        !player.ended &&
        player.currentTime > previousTime + 0.25;
      previousTime = player.currentTime;
      void heartbeat(progressed);
    };
    const timer = window.setInterval(tick, 30_000);
    const visibility = () => {
      previousTime = player.currentTime;
      if (document.visibilityState !== "visible") void heartbeat(false);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      void heartbeat(false);
    };
  }, [active, playing, canEarn, heartbeat]);

  const changeReaction = async (reaction: LiveReaction) => {
    if (!canReact || reactionPending) return;
    setReactionPending(true);
    setMessage("");
    try {
      const next = engagement?.myReaction === reaction ? null : reaction;
      const result = await request<Engagement>(
        `/api/live-sessions/${encodeURIComponent(session.id)}/reaction`,
        { method: "PUT", body: JSON.stringify({ reaction: next }) },
      );
      setEngagement(result);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setReactionPending(false);
    }
  };

  const storeName = session.seller?.store?.name ?? "Independent store";
  const storeSlug = session.seller?.store?.slug;
  const linkedProducts = liveSession.products ?? [];
  const legacyProductFlags =
    linkedProducts.length > 0 &&
    linkedProducts.every((link) => link.shopFeatured === undefined);
  const activeShopProducts = linkedProducts
    .filter((link) =>
      legacyProductFlags ? link.featured : link.shopFeatured === true,
    )
    .slice(0, 6);
  const activeShopProductIds = new Set(
    activeShopProducts.map((link) => link.productId),
  );
  const historicalProducts = linkedProducts.filter(
    (link) => !activeShopProductIds.has(link.productId),
  );
  return (
    <article
      className="liveWatchSlide"
      aria-label={`${session.title}, ${storeName}`}
    >
      <div className="liveWatchVideo">
        {active ? (
          <LiveKitViewer
            sessionId={session.id}
            className="liveWatchMount"
            onVideo={(element) => {
              video.current = element;
            }}
            onPlayback={(value) => {
              setPlaying(value);
              if (value) void heartbeat(true);
              else void heartbeat(false);
            }}
            onError={(reason) => {
              setPlaybackError(reason);
              setPlaying(false);
              void heartbeat(false);
            }}
          />
        ) : (
          <div className="liveWatchStandby" aria-hidden="true">
            <span>LIVE</span>
          </div>
        )}
        <div className="liveWatchVideoShade" />
        <div className="liveWatchLiveTag">
          <span /> LIVE
        </div>
        <div className="liveWatchVideoCounts">
          <span
            aria-label={`${engagement?.viewCount ?? "View count loading"} total views`}
          >
            ◉ {engagement?.viewCount ?? "—"}
          </span>
          <span
            aria-label={`${engagement?.viewersNow ?? "Viewer count unavailable"} watching now`}
          >
            ● {engagement?.viewersNow ?? "—"} watching
          </span>
        </div>
        <div className="liveWatchOverlayCopy">
          <p className="eyebrow">{storeName}</p>
          <h2>{session.title}</h2>
          {session.description && <p>{session.description}</p>}
          {storeSlug && (
            <a href={`/store/${encodeURIComponent(storeSlug)}`}>
              Visit store <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
        <div className="liveWatchReactionRail" aria-label="Live reactions">
          {reactionOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              className={
                engagement?.myReaction === option.key
                  ? "liveReaction active"
                  : "liveReaction"
              }
              onClick={() => void changeReaction(option.key)}
              disabled={!canReact || reactionPending}
              aria-pressed={engagement?.myReaction === option.key}
              aria-label={`${option.label}, ${engagement?.reactions[option.key] ?? 0}${!canReact ? ", sign in to react" : ""}`}
              title={canReact ? option.label : "Sign in to react"}
            >
              <span>{option.emoji}</span>
              <small>{engagement?.reactions[option.key] ?? 0}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="liveWatchInfo">
        <div className="liveWatchInfoHeading">
          <strong>{storeName}</strong>
          <span>{engagement?.viewCount ?? 0} views</span>
        </div>
        <LiveSocialActions sessionId={session.id} title={session.title} />
        {!!activeShopProducts.length && (
          <div
            className="liveWatchProducts"
            aria-label="Shop products in this live show"
          >
            {activeShopProducts.map(
              (link) =>
                link.product && (
                  <button
                    className="liveWatchProduct liveWatchProductAction"
                    key={link.productId}
                    type="button"
                    onClick={() => setSelectedProductId(link.productId)}
                  >
                    <span>
                      {link.shopFeatured
                        ? link.shopPinned
                          ? "Featured now"
                          : "Shop this item"
                        : "Featured now"}
                    </span>
                    <strong>{link.product.name}</strong>
                    <small>
                      {typeof link.product.priceMinor === "number" &&
                      link.product.currency
                        ? formatMinor(
                            link.product.salePriceMinor ??
                              link.product.priceMinor,
                            link.product.currency,
                          )
                        : "See current price"}{" "}
                      · Tap for item details
                    </small>
                  </button>
                ),
            )}
          </div>
        )}
        {!!historicalProducts.length && (
          <section
            className="liveWatchHistory"
            aria-label="Previously linked products"
          >
            <h3>Previously linked products</h3>
            <div className="liveWatchProducts">
              {historicalProducts.map(
                (link) =>
                  link.product && (
                    <a
                      className="liveWatchProduct"
                      key={link.productId}
                      href={`/products/${encodeURIComponent(link.product.id)}`}
                    >
                      <span>
                        {link.featured
                          ? "Previously featured"
                          : "From this show"}
                      </span>
                      <strong>{link.product.name}</strong>
                      <small>View product</small>
                    </a>
                  ),
              )}
            </div>
          </section>
        )}
        {canEarn && (
          <div className="liveWatchAttendance">
            <span>
              {rewarded
                ? "Live attendance reward earned"
                : `Attendance ${Math.floor(duration / 60)} / ${Math.ceil(threshold / 60)} min`}
            </span>
            <progress
              max={threshold}
              value={Math.min(duration, threshold)}
              aria-label="Live attendance reward progress"
            />
          </div>
        )}
        {!canReact && (
          <p className="liveWatchHint">
            <a href="/?auth=login">Sign in</a> to react and join the
            conversation.
            {!canEarn &&
              " Verify your email to qualify for attendance rewards."}
          </p>
        )}
        {canReact && !canEarn && (
          <p className="liveWatchHint">
            Verify your email in{" "}
            <a href="/settings#profile">account settings</a> to qualify for live
            attendance rewards.
          </p>
        )}
        {playbackError && (
          <p className="liveWatchMessage" role="status">
            {playbackError}
          </p>
        )}
        {message && (
          <p className="liveWatchMessage" role="status">
            {message}
          </p>
        )}
      </div>
      {selectedProductId && (
        <LiveShoppableProductDialog
          sessionId={session.id}
          productId={selectedProductId}
          onClose={closeProductDialog}
          request={request}
        />
      )}
    </article>
  );
}
