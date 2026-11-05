import { useEffect, useMemo, useRef, useState } from "react";
import "./ProductMediaGallery.css";

export type PublicProductVariant = {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  stock: number;
  image?: { id: string; url: string } | null;
};

export type ProductGalleryItem = {
  id: string;
  kind: "IMAGE" | "VIDEO" | "DOCUMENT" | string;
  url: string;
  alt?: string | null;
  label?: string | null;
  originalName?: string;
  detectedMime?: string;
};

export function ProductMediaGallery({
  productName,
  media,
  variantImage,
  compact = false,
}: {
  productName: string;
  media: readonly ProductGalleryItem[];
  variantImage?: PublicProductVariant["image"];
  compact?: boolean;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const [reducedMotion, setReducedMotion] = useState(false);
  const [saveData, setSaveData] = useState(false);
  const [videoAutoplayBlocked, setVideoAutoplayBlocked] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);

  const items = useMemo<ProductGalleryItem[]>(() => {
    const productMedia = [...media];
    if (variantImage?.url) {
      const defaultIndex = productMedia.findIndex(
        (item) => item.url === variantImage.url,
      );
      if (defaultIndex >= 0) productMedia.splice(defaultIndex, 1);
      productMedia.unshift({
        id: `variant-${variantImage.id}`,
        kind: "IMAGE",
        url: variantImage.url,
        alt: `${productName} selected option image`,
      });
    }
    return productMedia;
  }, [media, productName, variantImage?.id, variantImage?.url]);

  useEffect(() => setIndex(0), [items]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.1 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    updateMotion();
    motion.addEventListener("change", updateMotion);
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    setSaveData(Boolean(connection?.saveData));
    const updatePage = () =>
      setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", updatePage);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updatePage);
    };
  }, []);

  const imageIndexes = useMemo(
    () =>
      items.flatMap((item, itemIndex) =>
        item.kind === "IMAGE" ? [itemIndex] : [],
      ),
    [items],
  );
  const canRotate = imageIndexes.length > 1;
  const active = items[index] ?? null;
  const autoplayAllowed = visible && pageVisible && !reducedMotion && !saveData;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      setVideoPlaying(false);
      return undefined;
    }
    if (!autoplayAllowed || videoAutoplayBlocked) {
      video.pause();
      setVideoPlaying(false);
      return undefined;
    }
    video.muted = true;
    void video
      .play()
      .then(() => {
        if (videoRef.current === video) setVideoPlaying(true);
      })
      .catch(() => {
        if (videoRef.current === video) {
          setVideoAutoplayBlocked(true);
          setVideoPlaying(false);
        }
      });
    return undefined;
  }, [active?.id, autoplayAllowed, videoAutoplayBlocked]);

  useEffect(() => {
    if (
      !canRotate ||
      paused ||
      hovered ||
      focused ||
      reducedMotion ||
      saveData ||
      !visible ||
      !pageVisible ||
      videoPlaying
    )
      return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        const next =
          imageIndexes.find((imageIndex) => imageIndex > current) ??
          imageIndexes[0] ??
          0;
        return next;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [
    canRotate,
    focused,
    hovered,
    imageIndexes,
    pageVisible,
    paused,
    reducedMotion,
    saveData,
    visible,
    videoPlaying,
  ]);

  const move = (direction: -1 | 1) => {
    if (!items.length) return;
    setIndex((current) => (current + direction + items.length) % items.length);
  };

  return (
    <section
      ref={rootRef}
      className={`productMediaGallery${compact ? " is-compact" : ""}`}
      aria-label={`${productName} media gallery`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <div className="productMediaGalleryStage" aria-live="off">
        {active?.kind === "IMAGE" ? (
          <img
            key={active.id}
            src={active.url}
            alt={
              active.alt || active.label || `${productName} image ${index + 1}`
            }
            loading={index === 0 ? "eager" : "lazy"}
            decoding="async"
          />
        ) : active?.kind === "VIDEO" ? (
          <video
            ref={videoRef}
            key={active.id}
            src={active.detectedMime ? undefined : active.url}
            aria-label={active.label || `${productName} product video`}
            controls
            muted
            playsInline
            loop
            preload="none"
            poster={items.find((item) => item.kind === "IMAGE")?.url}
            onPlay={() => {
              setVideoAutoplayBlocked(false);
              setVideoPlaying(true);
            }}
            onPause={() => setVideoPlaying(false)}
            onEnded={() => setVideoPlaying(false)}
          >
            {active.detectedMime && (
              <source src={active.url} type={active.detectedMime} />
            )}
          </video>
        ) : active?.kind === "DOCUMENT" ? (
          <a className="productMediaDocument" href={active.url} download>
            {active.label || active.originalName || "Download product file"}
          </a>
        ) : (
          <div
            className="productVisual productVisualFallback"
            aria-label={`${productName} image unavailable`}
          >
            <span>{productName.slice(0, 1)}</span>
          </div>
        )}
      </div>
      {active?.kind === "VIDEO" &&
        !videoPlaying &&
        (!autoplayAllowed || videoAutoplayBlocked) && (
          <button
            type="button"
            className="productMediaVideoFallback"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = true;
              void video
                .play()
                .then(() => {
                  setVideoAutoplayBlocked(false);
                  setVideoPlaying(true);
                })
                .catch(() => setVideoAutoplayBlocked(true));
            }}
          >
            Play product video
          </button>
        )}
      {(items.length > 1 || canRotate) && (
        <div className="productMediaGalleryControls">
          {items.length > 1 && (
            <button
              type="button"
              aria-label={`Previous ${productName} media`}
              onClick={() => move(-1)}
            >
              Previous
            </button>
          )}
          {canRotate && (
            <button
              type="button"
              aria-pressed={paused}
              onClick={() => setPaused((current) => !current)}
            >
              {paused ? "Resume image rotation" : "Pause image rotation"}
            </button>
          )}
          {items.length > 1 && (
            <button
              type="button"
              aria-label={`Next ${productName} media`}
              onClick={() => move(1)}
            >
              Next
            </button>
          )}
          <small>
            {index + 1} of {items.length}
          </small>
        </div>
      )}
      {canRotate && (reducedMotion || saveData) && (
        <small className="productMediaMotionNote" role="status">
          Automatic rotation is off for your motion or data-saving preference.
        </small>
      )}
    </section>
  );
}
