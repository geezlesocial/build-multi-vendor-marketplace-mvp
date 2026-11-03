import React from "react";
import { MessageVideoPreview } from "./MessageVideoPreview.js";

type MessageFileDraft = {
  key: string;
  file: File;
  previewUrl: string;
  attachmentId?: string;
  assetId?: string;
  scanStatus?: string;
};

type ReactionOption = {
  kind: "LIKE" | "LOVE" | "HAPPY";
  emoji: string;
  label: string;
};

type MessageThreadProps = {
  activeConversation: any;
  currentUserId: string;
  loading: boolean;
  thread: any[];
  drafts: MessageFileDraft[];
  scanRetryBusy: string;
  reactionBusy: string;
  busy: boolean;
  body: string;
  mediaAccept: string;
  reactionOptions: readonly ReactionOption[];
  setBody: React.Dispatch<React.SetStateAction<string>>;
  onRetryAttachmentScan: (message: any, attachment: any) => void;
  onReact: (message: any, kind: ReactionOption["kind"]) => void;
  onRemoveDraft: (draft: MessageFileDraft) => void;
  onSendMessage: (event: React.FormEvent<HTMLFormElement>) => void;
  onAddFiles: (files: File[]) => void;
};

export function DashboardMessageThread({
  activeConversation,
  currentUserId,
  loading,
  thread,
  drafts,
  scanRetryBusy,
  reactionBusy,
  busy,
  body,
  mediaAccept,
  reactionOptions,
  setBody,
  onRetryAttachmentScan,
  onReact,
  onRemoveDraft,
  onSendMessage,
  onAddFiles,
}: MessageThreadProps) {
  if (!activeConversation) {
    return (
      <div className="messagesThread messagesThreadEmpty">
        <p>Select a conversation to view the thread.</p>
      </div>
    );
  }

  return (
    <div className="messagesThread">
      {activeConversation.product && (
        <a
          className="messagesProductContext"
          href={`/products/${encodeURIComponent(activeConversation.product.id)}`}
        >
          {activeConversation.product.images?.[0]?.url && (
            <img src={activeConversation.product.images[0].url} alt="" />
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
                  <div className="messageAttachment" key={attachment.id}>
                    {attachment.scanStatus === "APPROVED" && attachment.url ? (
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
                            : attachment.scanErrorCode === "SCANNER_UNAVAILABLE"
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
                                onRetryAttachmentScan(message, attachment)
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
            <div className="messageReactions" aria-label="React to message">
              {reactionOptions.map((option) => (
                <button
                  type="button"
                  key={option.kind}
                  aria-label={`${option.label}${message.reactions?.[option.kind] ? `, ${message.reactions[option.kind]}` : ""}`}
                  aria-pressed={message.myReaction === option.kind}
                  disabled={reactionBusy === message.id}
                  onClick={() => onReact(message, option.kind)}
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
                onClick={() => onRemoveDraft(draft)}
              >
                Remove
              </button>
            </figure>
          ))}
        </div>
      )}
      <form className="messagesComposer" onSubmit={onSendMessage}>
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
              accept={mediaAccept}
              disabled={
                busy ||
                activeConversation.status !== "OPEN" ||
                drafts.length >= 5
              }
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                if (files.length) onAddFiles(files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <small>
            Up to 5 files · images 5 MB · videos 50 MB · previews stay local
            until sent
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
  );
}
