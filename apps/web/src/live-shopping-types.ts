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
