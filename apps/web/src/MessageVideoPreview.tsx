import { useEffect, useRef } from 'react';

/** Muted, in-view previews make received clips immediately understandable without
 * forcing audio or decoding every video in a long conversation at once. */
export function MessageVideoPreview({ src, label }: { src: string; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) {
      void element.play().catch(() => undefined);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          element.muted = true;
          void element.play().catch(() => undefined);
        } else {
          element.pause();
        }
      }
    }, { threshold: [0, 0.5] });
    observer.observe(element);
    return () => { observer.disconnect(); element.pause(); };
  }, [src]);
  return <video ref={video} controls muted playsInline preload="metadata" aria-label={label} src={src} />;
}
