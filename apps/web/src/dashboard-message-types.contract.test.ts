import type {
  MessageAttachmentUploadResponse,
  MessageConversationSummary,
  MessageReactionResponse,
  MessageScanRetryResponse,
  MessageThreadItem,
} from "./dashboard-message-types.js";

const conversation = {
  id: "conversation-id",
  status: "OPEN",
  buyer: { id: "buyer-id", name: "Buyer" },
  directRecipient: null,
  seller: { store: { name: "Seller store" } },
  product: {
    id: "product-id",
    name: "Product",
    images: [{ url: "/product-image.png" }],
  },
  messages: [{ body: "Latest message" }],
} satisfies MessageConversationSummary;

const message = {
  id: "message-id",
  conversationId: conversation.id,
  senderId: "buyer-id",
  body: "Hello",
  sentAt: "2026-11-07T00:00:00.000Z",
  readAt: null,
  sender: { id: "buyer-id", name: "Buyer" },
  attachments: [
    {
      id: "asset-id",
      kind: "IMAGE",
      originalName: "image.png",
      sizeBytes: 128,
      scanStatus: "QUARANTINED",
      scanErrorCode: "SCANNER_UNAVAILABLE",
      uploadStatus: "COMPLETE",
      url: null,
    },
  ],
  reactions: { LIKE: 0, LOVE: 1, HAPPY: 0 },
  myReaction: "LOVE",
} satisfies MessageThreadItem;

const upload = {
  id: "attachment-id",
  assetId: "asset-id",
  kind: "IMAGE",
  originalName: "image.png",
  sizeBytes: 128,
  scanStatus: "QUARANTINED",
  message: "File is uploaded privately.",
} satisfies MessageAttachmentUploadResponse;

const reaction = {
  messageId: message.id,
  reactions: { LIKE: 0, LOVE: 1, HAPPY: 0 },
  myReaction: "LOVE",
} satisfies MessageReactionResponse;

const scanRetry = {
  scanStatus: "APPROVED",
  message: "The attachment is now available.",
} satisfies MessageScanRetryResponse;

export const dashboardMessageContractFixtures = {
  conversation,
  message,
  upload,
  reaction,
  scanRetry,
};
