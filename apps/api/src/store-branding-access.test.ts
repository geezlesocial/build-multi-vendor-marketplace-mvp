import { Role, SellerStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sellerFindFirst = vi.fn(async () => ({
    id: "seller-b",
    userId: "seller-b-owner",
    store: { id: "store-b", isPlatformStore: false },
  }));
  const sellerStaffFindFirst = vi.fn(async () => null);
  return {
    sellerFindFirst,
    sellerStaffFindFirst,
    prisma: {
      seller: { findFirst: sellerFindFirst },
      sellerStaff: { findFirst: sellerStaffFindFirst },
    },
  };
});

vi.mock("./security.js", () => ({ prisma: mocks.prisma }));

import { authorizedBrandingStore } from "./store-branding-access.js";

describe("authorized store-branding access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies a different seller's store to a seller without branding permission", async () => {
    await expect(
      authorizedBrandingStore({
        id: "seller-a-user",
        sellerId: "seller-b",
        role: Role.SELLER,
      }),
    ).resolves.toBeNull();

    expect(mocks.sellerFindFirst).toHaveBeenCalledWith({
      where: { id: "seller-b", status: SellerStatus.APPROVED },
      select: { id: true, userId: true, store: true },
    });
    expect(mocks.sellerStaffFindFirst).toHaveBeenCalledWith({
      where: {
        sellerId: "seller-b",
        userId: "seller-a-user",
        canManageStoreBranding: true,
      },
    });
  });

  it("keeps the seller owner authorized without a staff lookup", async () => {
    const store = await authorizedBrandingStore({
      id: "seller-b-owner",
      sellerId: "seller-b",
      role: Role.SELLER,
    });

    expect(store).toEqual({ id: "store-b", isPlatformStore: false });
    expect(mocks.sellerStaffFindFirst).not.toHaveBeenCalled();
  });
});
