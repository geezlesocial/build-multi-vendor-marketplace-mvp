export type MessageReactionKind = "LIKE" | "LOVE" | "HAPPY";

export type MessageReactionCounts = Record<MessageReactionKind, number>;

export type MessageScanStatus = "QUARANTINED" | "APPROVED" | "REJECTED";

export type MessageMediaKind = "IMAGE" | "VIDEO";

export type MessageAttachment = {
  id: string;
  kind: MessageMediaKind;
  originalName: string;
  sizeBytes: number;
  scanStatus: MessageScanStatus;
  scanErrorCode: string | null;
  uploadStatus: "PENDING" | "VERIFYING" | "COMPLETE" | "FAILED";
  url: string | null;
};

export type MessageThreadItem = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  sender: { id: string; name: string };
  attachments: MessageAttachment[];
  reactions: MessageReactionCounts;
  myReaction: MessageReactionKind | null;
};

export type MessageConversationSummary = {
  id: string;
  status: "OPEN" | "CLOSED" | "BLOCKED";
  buyer: { id: string; name: string } | null;
  directRecipient: { id: string; name: string } | null;
  seller: { store: { name: string } | null } | null;
  product: {
    id: string;
    name: string;
    images: { url: string }[];
  } | null;
  messages: { body: string }[];
};

export type MessageFileDraft = {
  key: string;
  file: File;
  previewUrl: string;
  attachmentId?: string;
  assetId?: string;
  scanStatus?: MessageScanStatus;
};

export type MessageReactionOption = {
  kind: MessageReactionKind;
  emoji: string;
  label: string;
};

export type MessageAttachmentUploadResponse = {
  id?: string | null;
  assetId?: string;
  kind?: MessageMediaKind;
  originalName?: string;
  sizeBytes?: number;
  scanStatus?: MessageScanStatus;
  message?: string;
  error?: string;
};

export type MessageReactionResponse = {
  messageId: string;
  reactions: MessageReactionCounts;
  myReaction: MessageReactionKind | null;
};

export type MessageScanRetryResponse = {
  scanStatus: MessageScanStatus;
  message?: string;
};
