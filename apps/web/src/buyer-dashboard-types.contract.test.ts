import type { MessageConversationSummary } from "./dashboard-message-types.js";
import type {
  BuyerAddress,
  BuyerCart,
  BuyerCartItem,
  BuyerDashboardData,
  BuyerFavorite,
  BuyerNotification,
  BuyerOrder,
  BuyerOrderResolutionCase,
} from "./buyer-dashboard-types.js";

const resolutionCase = {
  id: "case-1",
  parentOrderId: "order-1",
  sellerOrderId: "seller-order-1",
  buyerId: "buyer-1",
  sellerId: "seller-1",
  type: "DELIVERY_DISPUTE",
  status: "OPEN",
  reason: "ITEM_NOT_RECEIVED",
  description: "The shipment has not arrived yet.",
  requestedAmountMinor: null,
  approvedAmountMinor: null,
  resolutionNote: null,
  manualRefundReference: null,
  settledAt: null,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  orderNumber: "ML-ORDER-1",
  currency: "USD",
  parentTotalMinor: 2599,
  sellerOrderTotalMinor: 2599,
  paymentMethod: "STRIPE",
  paymentStatus: "PAID",
  storeName: "Trail Store",
  buyerName: "Test Buyer",
  messages: [
    {
      id: "case-message-1",
      authorId: "buyer-1",
      authorName: "Test Buyer",
      authorRole: "BUYER",
      body: "Please check the tracking status.",
      createdAt: "2026-11-07T00:00:00.000Z",
    },
  ],
} satisfies BuyerOrderResolutionCase;

const order = {
  id: "order-1",
  orderNumber: "ML-ORDER-1",
  buyerId: "buyer-1",
  buyerEmail: "buyer@example.test",
  buyerName: "Test Buyer",
  addressJson: {
    line1: "1 Example Street",
    city: "Test City",
    region: "TS",
    postalCode: "1000",
    country: "US",
  },
  totalMinor: 2599,
  currency: "USD",
  status: "CONFIRMED",
  createdAt: "2026-11-07T00:00:00.000Z",
  affiliateClickId: null,
  payment: {
    id: "payment-1",
    parentId: "order-1",
    method: "STRIPE",
    status: "PAID",
    providerRef: null,
    paidAt: "2026-11-07T00:00:00.000Z",
  },
  sellerOrders: [
    {
      id: "seller-order-1",
      parentId: "order-1",
      sellerId: "seller-1",
      status: "PROCESSING",
      totalMinor: 2599,
      discountCode: null,
      discountMinor: 0,
      shippingSnapshotJson: null,
      shipmentStatus: "IN_TRANSIT",
      shippingCarrier: "Example Post",
      trackingNumber: "TRACK-123",
      trackingUrl: "https://carrier.example.test/track/TRACK-123",
      shippedAt: "2026-11-06T12:00:00.000Z",
      deliveredAt: null,
      receivedAt: null,
      receiptConfirmedById: null,
      commissionSnapshotJson: null,
      commissionPolicyVersionId: null,
      seller: {
        id: "seller-1",
        status: "APPROVED",
        store: { name: "Trail Store" },
      },
      items: [
        {
          id: "item-1",
          sellerOrderId: "seller-order-1",
          productId: "product-1",
          productName: "Trail Bottle",
          unitPriceMinor: 2599,
          quantity: 1,
          discountMinor: 0,
          currencySnapshot: null,
          displayAmountMinor: null,
          displayCurrency: null,
          fxSnapshotJson: null,
          variantId: null,
          variantName: null,
        },
      ],
      shipmentUpdates: [
        {
          id: "shipment-update-1",
          sellerOrderId: "seller-order-1",
          status: "IN_TRANSIT",
          carrier: "Example Post",
          trackingNumber: "TRACK-123",
          trackingUrl: "https://carrier.example.test/track/TRACK-123",
          note: null,
          createdById: "seller-user-1",
          createdAt: "2026-11-07T00:00:00.000Z",
        },
      ],
      receiptConfirmedBy: null,
      resolutionCase,
    },
  ],
} satisfies BuyerOrder;

const cartItem = {
  id: "cart-item-1",
  cartId: "cart-1",
  productId: "product-1",
  quantity: 2,
  variantId: "variant-1",
  product: {
    id: "product-1",
    name: "Trail Bottle",
    priceMinor: 2999,
    salePriceMinor: 2599,
    currency: "USD",
    seller: {
      id: "seller-1",
      status: "APPROVED",
      store: { name: "Trail Store" },
    },
  },
  variant: {
    id: "variant-1",
    name: "Ocean Blue",
    priceMinor: 2599,
    currency: "USD",
  },
} satisfies BuyerCartItem;

const favorite = {
  id: "favorite-1",
  userId: "buyer-1",
  productId: "product-1",
  createdAt: "2026-11-07T00:00:00.000Z",
  product: {
    id: "product-1",
    name: "Trail Bottle",
    priceMinor: 2999,
    salePriceMinor: 2599,
    currency: "USD",
    seller: {
      id: "seller-1",
      status: "APPROVED",
      store: { name: "Trail Store" },
    },
  },
} satisfies BuyerFavorite;

const notification = {
  id: "notification-1",
  userId: "buyer-1",
  channel: "IN_APP",
  eventType: "ORDER_SHIPMENT_UPDATED",
  title: "Shipping progress updated",
  body: "Your order is in transit.",
  link: "/dashboard?tab=orders",
  payloadJson: null,
  deliveryStatus: "SENT",
  readAt: null,
  createdAt: "2026-11-07T00:00:00.000Z",
} satisfies BuyerNotification;

const addressWithoutPin = {
  id: "address-1",
  userId: "buyer-1",
  label: "Home",
  line1: "1 Example Street",
  line2: null,
  city: "Test City",
  region: "TS",
  postalCode: "1000",
  country: "US",
  latitude: null,
  longitude: null,
  isDefault: true,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
} satisfies BuyerAddress;

const addressWithPin = {
  ...addressWithoutPin,
  id: "address-2",
  label: "Pickup point",
  latitude: 1.3521,
  longitude: 103.8198,
} satisfies BuyerAddress;

const conversation = {
  id: "conversation-1",
  status: "OPEN",
  buyer: { id: "buyer-1", name: "Test Buyer" },
  directRecipient: null,
  seller: { store: { name: "Trail Store" } },
  product: {
    id: "product-1",
    name: "Trail Bottle",
    images: [{ url: "/content-media/trail-bottle.png" }],
  },
  messages: [{ body: "Is this bottle available?" }],
} satisfies MessageConversationSummary;

const persistedCart = {
  id: "cart-1",
  userId: "buyer-1",
  updatedAt: "2026-11-07T00:00:00.000Z",
  items: [cartItem],
} satisfies BuyerCart;

const emptyCart = { items: [] } satisfies BuyerCart;

export const buyerDashboardContractFixtures = {
  dashboard: {
    orders: [order],
    cart: persistedCart,
    favorites: [favorite],
    conversations: [conversation],
    notifications: [notification],
    addresses: [addressWithoutPin, addressWithPin],
    affiliate: {
      id: "affiliate-1",
      status: "APPROVED",
      referralCode: "TRAIL123",
    },
  } satisfies BuyerDashboardData,
  emptyCart,
};
