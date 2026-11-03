import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./session.js";
import { LiveSocialActions } from "./LiveSocialActions.js";
import { LiveKitViewer } from "./LiveKitViewer.js";
import { LiveWatchModal } from "./LiveWatchExperience.js";
import { SellerLiveStudio } from "./LiveSellerStudio.js";
import { AdminLiveShopping } from "./AdminLiveShopping.js";
import { request } from "./live-shopping-api.js";
import type { LiveSession } from "./live-shopping-types.js";
import "./ProductReviews.css";
import "./LiveShopping.css";
import "./LiveSocial.css";

export { LiveKitViewer, LiveWatchModal, SellerLiveStudio, AdminLiveShopping };
export type { LiveSession } from "./live-shopping-types.js";
type Attendance = {
  attendance: {
    eligibleDurationSeconds: number;
    rewardedAt: string | null;
  } | null;
  rewardThresholdSeconds: number;
};
export function LiveShopping() {
  const { user } = useSession();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [watchOpen, setWatchOpen] = useState(false);
  const closeViewer = useCallback(() => setWatchOpen(false), []);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      const items = await request<LiveSession[]>("/api/live-sessions");
      setSessions(items);
      setMessage("");
    } catch (error) {
      setSessions([]);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
    inFlight.current = false;
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
  const liveSessions = sessions.filter(
    (session) => session.status === "LIVE" && session.realtimeAvailable,
  );
  useEffect(() => {
    if (!liveSessions.length) setWatchOpen(false);
  }, [liveSessions.length]);
  return (
    <section className="liveShopping">
      <header className="sectionHeading">
        <div>
          <p className="eyebrow">Live from independent stores</p>
          <h2>Live shopping</h2>
          <p className="muted">
            Session status refreshes every 10 seconds. Attendance rewards count
            only while a provider-backed live video is actively playing in this
            visible tab.
          </p>
        </div>
        <div className="liveDashboardHeaderActions">
          {liveSessions.length > 0 && (
            <button
              type="button"
              className="primary liveWatchDashboardButton"
              onClick={() => setWatchOpen(true)}
            >
              <span className="homeLiveDot" />
              Watch live sellers <b>{liveSessions.length}</b>
            </button>
          )}
          <span className="ordersLiveBadge">
            <i aria-hidden="true" />
            Updates every 10 seconds
          </span>
        </div>
      </header>
      {message && (
        <p className="notice" role="status">
          Live shopping is unavailable or could not refresh: {message}
        </p>
      )}
      {user && !user.emailVerifiedAt && (
        <p className="notice">
          Verify your email in <a href="/settings#profile">account settings</a>{" "}
          before earning live-attendance rewards.
        </p>
      )}
      {loading && (
        <div className="empty" role="status">
          Loading live sessions…
        </div>
      )}
      {!loading && !message && !sessions.length && (
        <div className="empty">No live sessions are available right now.</div>
      )}
      <div className="adminReviewList">
        {sessions.map((session) =>
          session.status === "ENDED" && session.replayAvailable ? (
            <LiveReplayCard key={session.id} session={session} />
          ) : (
            <LiveSessionCard
              key={session.id}
              session={session}
              canEarn={Boolean(user?.emailVerifiedAt)}
            />
          ),
        )}
      </div>
      {watchOpen && (
        <LiveWatchModal
          sessions={liveSessions}
          onClose={closeViewer}
          canEarn={Boolean(user?.emailVerifiedAt)}
          canReact={Boolean(user)}
        />
      )}
    </section>
  );
}

function LiveReplayCard({ session }: { session: LiveSession }) {
  return (
    <article className="card cardBody liveReplayCard">
      <p className="eyebrow">Published live replay</p>
      <h3>{session.title}</h3>
      <p className="muted">
        {session.seller?.store?.name ?? "Independent store"}
        {session.startedAt
          ? ` · Recorded ${new Date(session.startedAt).toLocaleString()}`
          : ""}
      </p>
      {session.description && <p>{session.description}</p>}
      {session.replayUrl && (
        <video
          className="liveReplayPlayer"
          controls
          preload="metadata"
          playsInline
          src={session.replayUrl}
        >
          Your browser does not support replay video.
        </video>
      )}
      <LiveSocialActions sessionId={session.id} title={session.title} compact />
      {!!session.products?.length && (
        <div
          className="liveProductRail"
          aria-label="Products featured in this replay"
        >
          {session.products.map(
            (link) =>
              link.product && (
                <a
                  className="liveProductLink"
                  key={link.productId}
                  href={`/products/${encodeURIComponent(link.product.id)}`}
                >
                  <span>
                    {link.shopFeatured
                      ? link.shopPinned
                        ? "Featured during show"
                        : "Shop item"
                      : link.featured
                        ? "Featured"
                        : "From this show"}
                  </span>
                  <strong>{link.product.name}</strong>
                  <small>View product</small>
                </a>
              ),
          )}
        </div>
      )}
    </article>
  );
}

function LiveSessionCard({
  session,
  canEarn,
}: {
  session: LiveSession;
  canEarn: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const heartbeatQueue = useRef<Promise<void>>(Promise.resolve());
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [playing, setPlaying] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState("");
  const duration = attendance?.attendance?.eligibleDurationSeconds ?? 0;
  const threshold = attendance?.rewardThresholdSeconds ?? 300;
  const rewarded = Boolean(attendance?.attendance?.rewardedAt);

  const heartbeat = useCallback(
    async (isPlaying: boolean) => {
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
          setError("");
        } catch (reason) {
          setError((reason as Error).message);
        }
      });
    },
    [canEarn, session.id],
  );

  useEffect(() => {
    const player = video.current;
    if (!playing || !player || !canEarn) return undefined;
    let previousTime = player.currentTime;
    const tick = () => {
      const visible = document.visibilityState === "visible";
      const progressed =
        visible &&
        !player.paused &&
        !player.ended &&
        player.currentTime > previousTime + 0.25;
      previousTime = player.currentTime;
      void heartbeat(progressed);
    };
    const timer = window.setInterval(tick, 30_000);
    const visibility = () => {
      previousTime = player.currentTime;
      void heartbeat(false);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      void heartbeat(false);
    };
  }, [playing, canEarn, heartbeat]);

  useEffect(() => {
    let active = true;
    void request<Attendance>(
      `/api/live-sessions/${encodeURIComponent(session.id)}/attendance`,
    )
      .then((value) => {
        if (active) setAttendance(value);
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    return () => {
      active = false;
    };
  }, [session.id]);

  const beginPlayback = () => {
    setPlaying(true);
    if (video.current)
      video.current.dataset.lastTime = String(video.current.currentTime);
    void heartbeat(true);
  };
  const pausePlayback = () => {
    setPlaying(false);
    void heartbeat(false);
  };
  const percent = Math.min(100, Math.round((duration / threshold) * 100));
  return (
    <article className="card adminReviewCard liveSessionCard">
      <div className="sectionHeading">
        <div>
          <span className="adminWalletBadge">
            {session.status.replaceAll("_", " ")}
          </span>
          <h3>{session.title}</h3>
          <p className="muted">
            {session.seller?.store?.name ?? "Independent store"}
            {session.scheduledAt
              ? ` · ${new Date(session.scheduledAt).toLocaleString()}`
              : ""}
          </p>
        </div>
        <strong>
          {rewarded
            ? "Reward earned"
            : `${Math.floor(duration / 60)} / ${Math.ceil(threshold / 60)} min`}
        </strong>
      </div>
      {session.description && <p>{session.description}</p>}
      {!!session.products?.length && (
        <div
          className="liveProductRail"
          aria-label="Products featured in this show"
        >
          {session.products.map(
            (link) =>
              link.product && (
                <a
                  className="liveProductLink"
                  key={link.productId}
                  href={`/products/${encodeURIComponent(link.product.id)}`}
                >
                  <span>
                    {link.shopFeatured
                      ? link.shopPinned
                        ? "Featured"
                        : "In this show"
                      : link.featured
                        ? "Featured"
                        : "In this show"}
                  </span>
                  <strong>{link.product.name}</strong>
                  {typeof link.product.availableStock === "number" && (
                    <small>{link.product.availableStock} available</small>
                  )}
                </a>
              ),
          )}
        </div>
      )}
      {session.status === "LIVE" && session.realtimeAvailable ? (
        watching ? (
          <>
            <LiveKitViewer
              sessionId={session.id}
              onVideo={(element) => {
                video.current = element;
              }}
              onPlayback={(active) => {
                if (active) beginPlayback();
                else pausePlayback();
              }}
              onError={(reason) => {
                setPlaying(false);
                setError(reason);
              }}
            />
            <button
              type="button"
              className="liveRefreshButton"
              onClick={() => {
                setWatching(false);
                pausePlayback();
              }}
            >
              Stop watching
            </button>
          </>
        ) : (
          <button
            type="button"
            className="liveInlinePreview"
            onClick={() => setWatching(true)}
          >
            <span className="liveInlinePreviewMark" aria-hidden="true">
              ▶
            </span>
            <span>
              <strong>Watch this live show</strong>
              <small>Connect to the live stream when you are ready.</small>
            </span>
            <span className="liveInlinePreviewArrow" aria-hidden="true">
              ↗
            </span>
          </button>
        )
      ) : (
        <p className="muted">
          The session is not currently broadcasting with a playable provider
          stream.
        </p>
      )}
      <progress
        max={100}
        value={percent}
        aria-label={`${percent}% of live attendance reward time`}
      />
      <small className="muted">
        {rewarded
          ? "Attendance reward recorded."
          : "Five minutes of eligible playback are required. Paused, hidden-tab, and disconnected time does not count."}
      </small>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
