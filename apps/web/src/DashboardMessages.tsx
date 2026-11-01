import React, { useCallback, useEffect, useRef, useState } from "react";
import { MessageVideoPreview } from "./MessageVideoPreview.js";
import "./Messages.css";
import { announceHeaderActivityChange } from "./header-activity-events.js";
import { request } from "./DashboardShared.js";

type MessageFileDraft = {
  key: string;
  file: File;
  previewUrl: string;
  attachmentId?: string;
  assetId?: string;
  scanStatus?: string;
};

const messageReactionOptions = [
  { kind: "LIKE", emoji: "👍", label: "Like" },
  { kind: "LOVE", emoji: "❤️", label: "Love" },
  { kind: "HAPPY", emoji: "😊", label: "Happy" },
] as const;

const messageMediaAccept =
  "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/ogg";

export function Messages({
  conversations,
  reload,
  currentUserId,
}: {
  conversations: any[];
  reload: () => void;
  currentUserId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("conversation"),
  );
  const [thread, setThread] = useState<any[]>([]);
  const [body, setBody] = useState("");
  const [drafts, setDrafts] = useState<MessageFileDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reactionBusy, setReactionBusy] = useState("");
  const [scanRetryBusy, setScanRetryBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const previews = useRef(new Set<string>());
  const activeConversation = conversations.find(
    (item) => item.id === selectedId,
  );

  const loadThread = useCallback(
    async (conversationId: string, signal?: AbortSignal) => {
      try {
        const messages = await request<any[]>(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          { signal },
        );
        setThread(messages);
        setError("");
      } catch (loadError) {
        if (!signal?.aborted)
          setError(
            (loadError as Error).message || "Messages could not be loaded.",
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedId) {
      setThread([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void loadThread(selectedId, controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void loadThread(selectedId, controller.signal);
    }, 12_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [selectedId, loadThread]);

  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const addFiles = (files: File[]) => {
    setError("");
    setNotice("");
    const remaining = Math.max(0, 5 - drafts.length);
    if (!remaining) {
      setError("A message can include up to five images or videos.");
      return;
    }
    const acceptedTypes = new Set(messageMediaAccept.split(","));
    const validFiles = files.filter((file) => {
      const max = file.type.startsWith("image/") ? 5_000_000 : 50_000_000;
      if (!acceptedTypes.has(file.type)) {
        setError(`${file.name} is not a supported image or video.`);
        return false;
      }
      if (file.size > max) {
        setError(
          `${file.name} is larger than the allowed ${file.type.startsWith("image/") ? "5 MB image" : "50 MB video"} size.`,
        );
        return false;
      }
      return true;
    });
    const accepted = validFiles.slice(0, remaining);
    if (validFiles.length > remaining)
      setError("Only five attachments can be added to one message.");
    const next = accepted.map((file, index) => {
      const previewUrl = URL.createObjectURL(file);
      previews.current.add(previewUrl);
      return { key: `${Date.now()}-${index}-${file.name}`, file, previewUrl };
    });
    setDrafts((current) => [...current, ...next]);
  };

  const selectConversation = async (conversationId: string) => {
    if (conversationId === selectedId) return;
    if (
      drafts.length &&
      !window.confirm("Discard the unsent message and its attachments?")
    )
      return;
    for (const draft of drafts) {
      if (draft.attachmentId && selectedId) {
        try {
          await request(
            `/api/conversations/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(draft.attachmentId)}`,
            { method: "DELETE" },
          );
        } catch (removeError) {
          setError((removeError as Error).message);
          return;
        }
      }
      URL.revokeObjectURL(draft.previewUrl);
      previews.current.delete(draft.previewUrl);
    }
    try {
      await request(
        `/api/conversations/${encodeURIComponent(conversationId)}/read`,
        { method: "POST", body: "{}" },
      );
      announceHeaderActivityChange();
    } catch (readError) {
      setError(
        (readError as Error).message ||
          "Conversation could not be marked as read.",
      );
      return;
    }
    setDrafts([]);
    setBody("");
    setError("");
    setNotice("");
    setSelectedId(conversationId);
  };

  const removeDraft = async (draft: MessageFileDraft) => {
    if (draft.attachmentId && selectedId) {
      try {
        await request(
          `/api/conversations/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(draft.attachmentId)}`,
          { method: "DELETE" },
        );
      } catch (removeError) {
        setError((removeError as Error).message);
        return;
      }
    }
    URL.revokeObjectURL(draft.previewUrl);
    previews.current.delete(draft.previewUrl);
    setDrafts((current) => current.filter((item) => item.key !== draft.key));
  };

  const uploadDraft = async (
    conversationId: string,
    draft: MessageFileDraft,
  ) => {
    if (draft.attachmentId) return draft;
    const csrf = document.cookie
      .split("; ")
      .find((value) => value.startsWith("marketplace_csrf="))
      ?.split("=")[1];
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
      {
        method: "POST",
        credentials: "include",
        body: draft.file,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(draft.file.name),
          "X-File-Type": draft.file.type,
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      id?: string;
      assetId?: string;
      scanStatus?: string;
      error?: string;
    };
    if (!response.ok || !result.id)
      throw new Error(result.error ?? "This attachment could not be uploaded.");
    return {
      ...draft,
      attachmentId: result.id,
      assetId: result.assetId,
      scanStatus: result.scanStatus,
    };
  };

  const sendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId || (!body.trim() && !drafts.length) || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const uploaded: MessageFileDraft[] = [];
      for (const draft of drafts) {
        const result = await uploadDraft(selectedId, draft);
        uploaded.push(result);
        setDrafts((current) =>
          current.map((item) => (item.key === result.key ? result : item)),
        );
      }
      const attachmentIds = uploaded.map((item) => {
        if (!item.attachmentId)
          throw new Error(
            "An attachment upload did not return a reference. Please retry.",
          );
        return item.attachmentId;
      });
      const response = await request(
        "/api/conversations/" + encodeURIComponent(selectedId) + "/messages",
        {
          method: "POST",
          body: JSON.stringify({ body: body.trim(), attachmentIds }),
        },
      );
      void response;
      announceHeaderActivityChange();
      setBody("");
      for (const draft of uploaded) {
        URL.revokeObjectURL(draft.previewUrl);
        previews.current.delete(draft.previewUrl);
      }
      setDrafts([]);
      setNotice(
        "Message sent. Attachments are visible to both participants after the safety scan approves them.",
      );
      await Promise.all([loadThread(selectedId), Promise.resolve(reload())]);
    } catch (sendError) {
      setError(
        (sendError as Error).message || "Your message could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  };

  const react = async (
    message: any,
    kind: (typeof messageReactionOptions)[number]["kind"],
  ) => {
    if (!selectedId || reactionBusy) return;
    setReactionBusy(message.id);
    setError("");
    try {
      const reaction = message.myReaction === kind ? null : kind;
      const result = await request<{
        reactions: Record<string, number>;
        myReaction: string | null;
      }>(
        `/api/conversations/${encodeURIComponent(selectedId)}/messages/${encodeURIComponent(message.id)}/reaction`,
        { method: "PUT", body: JSON.stringify({ reaction }) },
      );
      setThread((current) =>
        current.map((item) =>
          item.id === message.id ? { ...item, ...result } : item,
        ),
      );
    } catch (reactionError) {
      setError(
        (reactionError as Error).message || "Reaction could not be saved.",
      );
    } finally {
      setReactionBusy("");
    }
  };

  const retryAttachmentScan = async (message: any, attachment: any) => {
    if (!selectedId || scanRetryBusy) return;
    setScanRetryBusy(attachment.id);
    setError("");
    setNotice("");
    try {
      const result = await request<{ scanStatus: string; message?: string }>(
        `/api/conversations/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(attachment.id)}/scan-retry`,
        { method: "POST", body: "{}" },
      );
      await loadThread(selectedId);
      setNotice(
        result.scanStatus === "APPROVED"
          ? "Safety scan approved the attachment; it is now visible to both participants."
          : (result.message ??
              "The attachment remains private until the safety scan approves it."),
      );
    } catch (scanError) {
      setError(
        (scanError as Error).message || "The safety scan could not be retried.",
      );
    } finally {
      setScanRetryBusy("");
    }
  };

  return (
    <section className="messagesModule" aria-labelledby="messages-heading">
      <h2 id="messages-heading">Messages</h2>
      {!conversations.length ? (
        <div className="empty">
          No conversations yet. Contact a seller from a product listing to start
          a conversation.
        </div>
      ) : (
        <div className="messagesLayout">
          <nav className="messagesConversationList" aria-label="Conversations">
            {conversations.map((conversation) => {
              const otherName =
                conversation.buyer?.id !== currentUserId
                  ? conversation.buyer?.name
                  : conversation.directRecipient?.id !== currentUserId
                    ? conversation.directRecipient?.name
                    : (conversation.seller?.store?.name ??
                      conversation.seller?.name ??
                      "Marketplace member");
              const preview =
                conversation.messages?.[0]?.body ||
                (conversation.messages?.[0] ? "Attachment" : "No messages yet");
              return (
                <button
                  type="button"
                  data-conversation-id={conversation.id}
                  className={`messagesConversationButton${selectedId === conversation.id ? " isActive" : ""}`}
                  key={conversation.id}
                  aria-current={
                    selectedId === conversation.id ? "true" : undefined
                  }
                  disabled={busy}
                  onClick={() => void selectConversation(conversation.id)}
                >
                  <strong>
                    {conversation.product?.name ?? "Conversation"}
                  </strong>
                  <span>{otherName}</span>
                  <small>{preview}</small>
                </button>
              );
            })}
          </nav>
          {activeConversation ? (
            <div className="messagesThread">
              {activeConversation.product && (
                <a
                  className="messagesProductContext"
                  href={`/products/${encodeURIComponent(activeConversation.product.id)}`}
                >
                  {activeConversation.product.images?.[0]?.url && (
                    <img
                      src={activeConversation.product.images[0].url}
                      alt=""
                    />
                  )}
                  <span>
                    <small>Regarding this listing</small>
                    <strong>{activeConversation.product.name}</strong>
                    <small>View product details</small>
                  </span>
                </a>
              )}
              <div
                className="messagesThreadList"
                aria-live="polite"
                aria-busy={loading}
              >
                {loading && !thread.length && (
                  <p className="messagesStatus" role="status">
                    Loading conversation…
                  </p>
                )}
                {!loading && !thread.length && (
                  <p className="messagesStatus">
                    No messages yet. Write the first message below.
                  </p>
                )}
                {thread.map((message) => (
                  <article
                    className={`messageBubble${message.senderId === currentUserId ? " isMine" : ""}`}
                    key={message.id}
                  >
                    <header>
                      <strong>
                        {message.senderId === currentUserId
                          ? "You"
                          : (message.sender?.name ?? "Marketplace member")}
                      </strong>
                      <time dateTime={message.sentAt}>
                        {new Date(message.sentAt).toLocaleString()}
                      </time>
                    </header>
                    {message.body && <p>{message.body}</p>}
                    {!!message.attachments?.length && (
                      <div className="messageAttachments">
                        {message.attachments.map((attachment: any) => (
                          <div
                            className="messageAttachment"
                            key={attachment.id}
                          >
                            {attachment.scanStatus === "APPROVED" &&
                            attachment.url ? (
                              attachment.kind === "IMAGE" ? (
                                <a
                                  href={attachment.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <img
                                    src={attachment.url}
                                    alt={attachment.originalName}
                                    loading="lazy"
                                  />
                                </a>
                              ) : (
                                <MessageVideoPreview
                                  src={attachment.url}
                                  label={attachment.originalName}
                                />
                              )
                            ) : (
                              <div className="messageAttachmentPending">
                                <p className="messagesStatus" role="status">
                                  {attachment.scanStatus === "REJECTED"
                                    ? "This attachment did not pass the safety scan and cannot be opened."
                                    : attachment.scanErrorCode ===
                                        "SCANNER_UNAVAILABLE"
                                      ? `${attachment.originalName} is private because the malware scanner is unavailable. It will appear here after an approved scan.`
                                      : `${attachment.originalName} is being safety-checked and is private until approved.`}
                                </p>
                                {attachment.scanStatus === "QUARANTINED" &&
                                  message.senderId === currentUserId && (
                                    <button
                                      type="button"
                                      className="messagesRetryScan"
                                      disabled={scanRetryBusy === attachment.id}
                                      onClick={() =>
                                        void retryAttachmentScan(
                                          message,
                                          attachment,
                                        )
                                      }
                                    >
                                      {scanRetryBusy === attachment.id
                                        ? "Checking…"
                                        : "Retry safety scan"}
                                    </button>
                                  )}
                              </div>
                            )}
                            {attachment.scanStatus === "APPROVED" && (
                              <small>{attachment.originalName}</small>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div
                      className="messageReactions"
                      aria-label="React to message"
                    >
                      {messageReactionOptions.map((option) => (
                        <button
                          type="button"
                          key={option.kind}
                          aria-label={`${option.label}${message.reactions?.[option.kind] ? `, ${message.reactions[option.kind]}` : ""}`}
                          aria-pressed={message.myReaction === option.kind}
                          disabled={reactionBusy === message.id}
                          onClick={() => void react(message, option.kind)}
                        >
                          <span aria-hidden="true">{option.emoji}</span>
                          <span>{message.reactions?.[option.kind] ?? 0}</span>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              {drafts.length > 0 && (
                <div className="messageDrafts" aria-label="Files to send">
                  {drafts.map((draft) => (
                    <figure key={draft.key}>
                      {draft.file.type.startsWith("image/") ? (
                        <img
                          src={draft.previewUrl}
                          alt={`Preview of ${draft.file.name}`}
                        />
                      ) : (
                        <MessageVideoPreview
                          src={draft.previewUrl}
                          label={`Preview of ${draft.file.name}`}
                        />
                      )}
                      <figcaption>
                        {draft.file.name}
                        {draft.scanStatus === "QUARANTINED"
                          ? " · private pending scan"
                          : ""}
                      </figcaption>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${draft.file.name}`}
                        onClick={() => void removeDraft(draft)}
                      >
                        Remove
                      </button>
                    </figure>
                  ))}
                </div>
              )}
              <form
                className="messagesComposer"
                onSubmit={(event) => void sendMessage(event)}
              >
                <label htmlFor="message-compose">Write a message</label>
                <textarea
                  id="message-compose"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder="Write a reply…"
                  disabled={busy || activeConversation.status !== "OPEN"}
                />
                <div className="messagesComposerActions">
                  <label className="messagesFileButton">
                    Add images or video
                    <input
                      type="file"
                      multiple
                      accept={messageMediaAccept}
                      disabled={
                        busy ||
                        activeConversation.status !== "OPEN" ||
                        drafts.length >= 5
                      }
                      onChange={(event) => {
                        const files = Array.from(
                          event.currentTarget.files ?? [],
                        );
                        if (files.length) addFiles(files);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <small>
                    Up to 5 files · images 5 MB · videos 50 MB · previews stay
                    local until sent
                  </small>
                  <button
                    className="primary"
                    type="submit"
                    disabled={
                      busy ||
                      activeConversation.status !== "OPEN" ||
                      (!body.trim() && !drafts.length)
                    }
                  >
                    {busy ? "Sending…" : "Send message"}
                  </button>
                </div>
                {activeConversation.status !== "OPEN" && (
                  <p className="messagesStatus">This conversation is closed.</p>
                )}
              </form>
            </div>
          ) : (
            <div className="messagesThread messagesThreadEmpty">
              <p>Select a conversation to view the thread.</p>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}{" "}
          {selectedId && (
            <button type="button" onClick={() => void loadThread(selectedId)}>
              Retry messages
            </button>
          )}
        </p>
      )}
      {notice && (
        <p className="messagesNotice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
