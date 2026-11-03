export type LiveProduct = {
  id: string;
  name: string;
  description?: string;
  priceMinor?: number;
  salePriceMinor?: number | null;
  currency?: string;
  availableStock?: number;
  inventory?: { quantity: number } | null;
  status?: string;
  wholesaleEnabled?: boolean;
  wholesaleMinQuantity?: number | null;
  wholesaleMaxQuantity?: number | null;
  images?: { id?: string; url: string; alt: string }[];
  variants?: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
    stock: number;
    imageUrl?: string | null;
  }[];
};

export type LiveCartLine = {
  id: string;
  quantity: number;
  variant?: {
    id: string;
    name: string;
    priceMinor: number;
    currency: string;
  } | null;
  product: {
    id: string;
    name: string;
    priceMinor: number;
    salePriceMinor?: number | null;
    currency: string;
  };
};

export type LiveSession = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  scheduledAt?: string | null;
  startedAt?: string | null;
  recordingStatus?: string;
  replayPublishedAt?: string | null;
  replayAvailable?: boolean;
  replayUrl?: string;
  seller?: { store?: { name: string; slug?: string } | null };
  products?: {
    productId: string;
    featured: boolean;
    shopFeatured?: boolean;
    shopSortOrder?: number | null;
    shopPinned?: boolean;
    product?: LiveProduct;
  }[];
  playbackAvailable?: boolean;
  realtimeAvailable?: boolean;
  playbackUrl?: string;
};

export type LiveReadiness = {
  effectiveEnabled: boolean;
  deploymentGate: boolean;
  runtimeEnabled: boolean;
  reason: string;
  recordingAvailable?: boolean;
  recordingStorageConfigured?: boolean;
  readiness: {
    provider: string | null;
    configured: boolean;
    healthy: boolean;
    attendanceVerificationAvailable: boolean;
    reason: string;
  };
};
export type LiveProviderConfiguration = {
  provider: "LIVEKIT";
  configured: boolean;
  serverUrl: string | null;
  apiKeyConfigured: boolean;
  apiSecretConfigured: boolean;
  apiKeyMasked: string | null;
  deploymentGateEnabled: boolean;
  source: "ADMIN_DASHBOARD" | "DEPLOYMENT_ENVIRONMENT" | "NOT_CONFIGURED";
  configurationError: string | null;
};
export type AdminLiveProvider = {
  configuration: LiveProviderConfiguration;
  readiness: LiveReadiness["readiness"];
};
export type SellerLiveSession = LiveSession & {
  scheduledAt: string | null;
  timezone: string;
  deletedAt?: string | null;
  replayDeletionPending?: boolean;
  products: {
    productId: string;
    featured: boolean;
    shopFeatured?: boolean;
    shopSortOrder?: number | null;
    shopPinned?: boolean;
    product?: LiveProduct;
  }[];
};
