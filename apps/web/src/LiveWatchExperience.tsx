import React, { useEffect, useRef, useState } from "react";
import { LiveWatchSlide } from "./LiveWatchSlide.js";
import type { LiveSession } from "./live-shopping-types.js";

export function LiveWatchModal({
  sessions,
  onClose,
  canEarn,
  canReact,
}: {
  sessions: LiveSession[];
  onClose: () => void;
  canEarn: boolean;
  canReact: boolean;
}) {
  const feed = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const liveSessions = sessions.filter(
    (session) => session.status === "LIVE" && session.realtimeAvailable,
  );

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector(".liveProductDialog, .liveEmbedDialog"))
          return;
        onClose();
      }
      if (event.key === "Tab") {
        if (document.querySelector(".liveProductDialog, .liveEmbedDialog"))
          return;
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".liveWatchOverlay button:not(:disabled), .liveWatchOverlay a[href]",
          ),
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (!["ArrowDown", "PageDown", "ArrowUp", "PageUp"].includes(event.key))
        return;
      event.preventDefault();
      const direction =
        event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
      const next = Math.max(
        0,
        Math.min(liveSessions.length - 1, activeIndex + direction),
      );
      feed.current?.children[next]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      setActiveIndex(next);
    };
    document.addEventListener("keydown", handleKeys);
    return () => document.removeEventListener("keydown", handleKeys);
  }, [activeIndex, liveSessions.length, onClose]);

  useEffect(() => {
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, liveSessions.length - 1)),
    );
  }, [liveSessions.length]);

  useEffect(() => {
    const root = feed.current;
    if (!root) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const index = Array.from(root.children).indexOf(visible.target);
          if (index >= 0) setActiveIndex(index);
        }
      },
      { root, threshold: [0.55, 0.75] },
    );
    Array.from(root.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [liveSessions.length]);

  const move = (direction: number) => {
    const next = Math.max(
      0,
      Math.min(liveSessions.length - 1, activeIndex + direction),
    );
    feed.current?.children[next]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setActiveIndex(next);
  };

  if (!liveSessions.length) return null;
  return (
    <div
      className="liveWatchOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Watch live sellers"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="liveWatchTopbar">
        <a href="/" className="liveWatchBrand">
          Live shopping <span>{liveSessions.length} live</span>
        </a>
        <button
          ref={closeButton}
          type="button"
          className="liveWatchClose"
          onClick={onClose}
          aria-label="Close live shopping"
        >
          × <span>Close</span>
        </button>
      </div>
      <div className="liveWatchFeed" ref={feed}>
        {liveSessions.map((session, index) => (
          <LiveWatchSlide
            key={session.id}
            session={session}
            active={index === activeIndex}
            canEarn={canEarn}
            canReact={canReact}
          />
        ))}
      </div>
      {liveSessions.length > 1 && (
        <div className="liveWatchNav" aria-label="Change live seller">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={activeIndex === 0}
            aria-label="Previous live seller"
          >
            ↑
          </button>
          <span>
            {activeIndex + 1} / {liveSessions.length}
          </span>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={activeIndex === liveSessions.length - 1}
            aria-label="Next live seller"
          >
            ↓
          </button>
        </div>
      )}
    </div>
  );
}
