import { useEffect, useRef } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { request } from "./live-shopping-api.js";
export function LiveKitHost({
  sessionId,
  onPublished,
  onError,
}: {
  sessionId: string;
  onPublished: (published: boolean) => void;
  onError: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const publishedCallback = useRef(onPublished);
  const errorCallback = useRef(onError);

  useEffect(() => {
    publishedCallback.current = onPublished;
    errorCallback.current = onError;
  }, [onError, onPublished]);

  useEffect(() => {
    const mountElement = mount.current;
    let room: Room | null = null;
    let active = true;
    const connect = async () => {
      try {
        const credentials = await request<{ serverUrl: string; token: string }>(
          `/api/seller/live-sessions/${encodeURIComponent(sessionId)}/stream-token`,
        );
        if (!active || !mountElement) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (
            publication.kind !== Track.Kind.Video ||
            !publication.track ||
            !mountElement
          )
            return;
          const element = publication.track.attach();
          if (element instanceof HTMLVideoElement) {
            element.className = "liveSessionPlayer";
            element.autoplay = true;
            element.playsInline = true;
            element.muted = true;
            mountElement.appendChild(element);
          }
          publishedCallback.current(true);
        });
        room.on(RoomEvent.Disconnected, () => publishedCallback.current(false));
        await room.connect(credentials.serverUrl, credentials.token);
        await room.localParticipant.enableCameraAndMicrophone();
        const publishing = Array.from(
          room.localParticipant.trackPublications.values(),
        ).some((publication) => publication.kind === Track.Kind.Video);
        publishedCallback.current(publishing);
      } catch (reason) {
        if (active) {
          publishedCallback.current(false);
          errorCallback.current((reason as Error).message);
        }
      }
    };
    void connect();
    return () => {
      active = false;
      publishedCallback.current(false);
      room?.disconnect();
      mountElement?.replaceChildren();
    };
  }, [sessionId]);
  return (
    <div
      ref={mount}
      className="liveKitMount"
      aria-label="Live broadcast preview"
    />
  );
}
