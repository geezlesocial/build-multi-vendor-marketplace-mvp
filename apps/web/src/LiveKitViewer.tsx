import React, { useEffect, useRef } from "react";
import { Room, RoomEvent } from "livekit-client";
import { request } from "./live-shopping-api.js";

export function LiveKitViewer({
  sessionId,
  onVideo,
  onPlayback,
  onError,
  className = "",
}: {
  sessionId: string;
  onVideo: (element: HTMLVideoElement) => void;
  onPlayback: (active: boolean) => void;
  onError: (message: string) => void;
  className?: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onVideo, onPlayback, onError });
  useEffect(() => {
    callbacks.current = { onVideo, onPlayback, onError };
  }, [onError, onPlayback, onVideo]);

  useEffect(() => {
    const mountElement = mount.current;
    if (!mountElement) return undefined;
    let room: Room | null = null;
    let active = true;
    const connect = async () => {
      try {
        const credentials = await request<{ serverUrl: string; token: string }>(
          `/api/live-sessions/${encodeURIComponent(sessionId)}/token`,
        );
        if (!active || !mountElement.isConnected) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (!active || !mountElement.isConnected) return;
          const element = track.attach();
          mountElement.appendChild(element);
          if (element instanceof HTMLVideoElement) {
            element.className = "liveSessionPlayer";
            element.autoplay = true;
            element.playsInline = true;
            element.muted = true;
            element.controls = true;
            callbacks.current.onVideo(element);
            element.onplaying = () => callbacks.current.onPlayback(true);
            element.onpause = () => callbacks.current.onPlayback(false);
            void element
              .play()
              .then(() => callbacks.current.onPlayback(true))
              .catch(() =>
                callbacks.current.onError(
                  "Allow video playback in your browser to watch this show.",
                ),
              );
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove());
          callbacks.current.onPlayback(false);
        });
        room.on(RoomEvent.Disconnected, () =>
          callbacks.current.onPlayback(false),
        );
        await room.connect(credentials.serverUrl, credentials.token);
      } catch (reason) {
        if (active) callbacks.current.onError((reason as Error).message);
      }
    };
    void connect();
    return () => {
      active = false;
      callbacks.current.onPlayback(false);
      room?.disconnect();
      mountElement.replaceChildren();
    };
  }, [sessionId]);
  return (
    <div
      ref={mount}
      className={`liveKitMount ${className}`}
      aria-label="Live video"
    />
  );
}
