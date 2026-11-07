import type { MessageConversationSummary } from "./dashboard-message-types.js";

export type BuyerOrderStatus =
  "PENDING" | "CONFIRMED" | "PROCESSING" | "FULFILLED" | "CANCELLED";

export type BuyerPaymentMethod =
  "STRIPE" | "PAYPAL" | "PAYMONGO" | "PAYSTACK" | "COD" | "POS";

export type BuyerPaymentStatus =
  "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "REFUNDED" | "DISPUTED";

export type BuyerShipmentStatus =
  "SHIPPED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION";

export type BuyerJsonValue =
  | string
  | number
  | boolean
  | null
  | BuyerJsonValue[]
  | { [key: string]: BuyerJsonValue };

export type BuyerPaymentSummary = {
  id: string;
  parentId: string;
  method: BuyerPaymentMethod;
  status: BuyerPaymentStatus;
  providerRef: string | null;
  paidAt: string | null;
};

export type BuyerOrderItem = {
  id: string;
  sellerOrderId: string;
  productId: string;
  productName: string;
  unitPriceMinor: number;
  quantity: number;
  discountMinor: number;
  currencySnapshot: string | null;
  displayAmountMinor: number | null;
  displayCurrency: string | null;
  fxSnapshotJson: BuyerJsonValue | null;
  variantId: string | null;
  variantName: string | null;
};

export type BuyerShipmentUpdate = {
  id: string;
  sellerOrderId: string;
  status: BuyerShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  note: string | null;
  createdById: string;
  createdAt: string;
};

export type BuyerOrderResolutionMessage = {
  id: string;
  authorId: string;
  authorName: string | null;
  authorRole: string;
  body: string;
  createdAt: string;
};

// Mirrors the sanitized CaseRow returned by the buyer dashboard route.
export type BuyerOrderResolutionCase = {
  id: string;
  parentOrderId: string;
  sellerOrderId: string;
  buyerId: string;
  sellerId: string | null;
  type: string;
  status: string;
  reason: string;
  description: string;
  requestedAmountMinor: number | null;
  approvedAmountMinor: number | null;
  resolutionNote: string | null;
  manualRefundReference: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
  orderNumber: string;
  currency: string;
  parentTotalMinor: number;
  sellerOrderTotalMinor: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
  storeName: string | null;
  buyerName: string;
  messages: BuyerOrderResolutionMessage[];
};

export type BuyerSellerSummary = {
  id: string;
  status: string;
  store: { name: string } | null;
};

export type BuyerSellerOrder = {
  id: string;
  parentId: string;
  sellerId: string | null;
  status: BuyerOrderStatus;
  totalMinor: number;
  discountCode: string | null;
  discountMinor: number;
  shippingSnapshotJson: BuyerJsonValue | null;
  shipmentStatus: BuyerShipmentStatus | null;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
  receiptConfirmedById: string | null;
  commissionSnapshotJson: BuyerJsonValue | null;
  commissionPolicyVersionId: string | null;
  seller: BuyerSellerSummary | null;
  items: BuyerOrderItem[];
  shipmentUpdates: BuyerShipmentUpdate[];
  receiptConfirmedBy: { id: string; name: string } | null;
  resolutionCase: BuyerOrderResolutionCase | null;
};

export type BuyerOrder = {
  id: string;
  orderNumber: string;
  buyerId: string | null;
  buyerEmail: string;
  buyerName: string;
  addressJson: BuyerJsonValue;
  totalMinor: number;
  currency: string;
  status: BuyerOrderStatus;
  createdAt: string;
  affiliateClickId: string | null;
  payment: BuyerPaymentSummary | null;
  sellerOrders: BuyerSellerOrder[];
};

// The included API records have additional persisted fields; this projection
// names the product and seller fields consumed by buyer dashboard components.
export type BuyerProductSummary = {
  id: string;
  name: string;
  priceMinor: number;
  salePriceMinor: number | null;
  currency: string;
  seller: BuyerSellerSummary | null;
};

export type BuyerCartVariant = {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
};

export type BuyerCartItem = {
  id: string;
  cartId: string;
  productId: string;
  quantity: number;
  variantId: string | null;
  product: BuyerProductSummary;
  variant: BuyerCartVariant | null;
};

// The API returns a persisted cart when present and { items: [] } otherwise.
export type BuyerCart =
  | { id: string; userId: string; updatedAt: string; items: BuyerCartItem[] }
  | { items: BuyerCartItem[] };

export type BuyerFavorite = {
  id: string;
  userId: string;
  productId: string;
  createdAt: string;
  product: BuyerProductSummary;
};

export type BuyerNotification = {
  id: string;
  userId: string;
  channel: "IN_APP" | "EMAIL" | "WEB_PUSH" | "ANDROID_PUSH";
  eventType: string;
  title: string;
  body: string;
  link: string | null;
  payloadJson: BuyerJsonValue | null;
  deliveryStatus: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SUPPRESSED";
  readAt: string | null;
  createdAt: string;
};

export type BuyerAddress = {
  id: string;
  userId: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BuyerAffiliateSummary = {
  id: string;
  status: "APPROVED";
  referralCode: string;
};

export type BuyerDashboardData = {
  orders: BuyerOrder[];
  cart: BuyerCart;
  favorites: BuyerFavorite[];
  conversations: MessageConversationSummary[];
  notifications: BuyerNotification[];
  addresses: BuyerAddress[];
  affiliate: BuyerAffiliateSummary | null;
};

export type BuyerData = BuyerDashboardData;
