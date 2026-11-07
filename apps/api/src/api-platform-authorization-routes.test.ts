import { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  addSession,
  authMocks,
  request,
  startServer,
} from "../test-support/api-auth-test-fixtures.js";

describe("HTTP platform authorization boundaries", () => {
  it("keeps platform branding private to admins while allowing the legitimate admin read", async () => {
    const baseUrl = await startServer();
    const privateDraft = {
      id: "default",
      draftJson: { platformName: "Synthetic private draft" },
      updatedById: "synthetic-admin-user",
    };
    authMocks.brandingLookup.mockResolvedValue(privateDraft as never);

    for (const role of [Role.BUYER, Role.SELLER, Role.PLATFORM_STAFF]) {
      const session = addSession(role);
      const denied = await request(baseUrl, "/api/admin/platform/branding", {
        token: session.token,
      });
      expect(denied.status, role).toBe(403);
    }
    expect(authMocks.brandingLookup).not.toHaveBeenCalled();

    const admin = addSession(Role.ADMIN);
    const allowed = await request(baseUrl, "/api/admin/platform/branding", {
      token: admin.token,
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(privateDraft);
    expect(authMocks.brandingLookup).toHaveBeenCalledOnce();
  });

  it("denies a seller staff session after its store-branding permission is revoked", async () => {
    const baseUrl = await startServer();
    const staff = addSession(Role.SELLER, { staffSellerId: "seller-a" });
    authMocks.sellerLookup.mockResolvedValue({
      id: "seller-a",
      userId: "seller-a-owner",
      store: { id: "store-a", isPlatformStore: false },
    } as never);
    authMocks.sellerStaffLookup.mockResolvedValue(null);

    const response = await request(baseUrl, "/api/seller/store-theme", {
      token: staff.token,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Approved Store owner or authorized branding staff required",
    });
    expect(authMocks.sellerLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "seller-a" }),
      }),
    );
    expect(authMocks.sellerStaffLookup).toHaveBeenCalledWith({
      where: {
        sellerId: "seller-a",
        userId: staff.userId,
        canManageStoreBranding: true,
      },
    });
    expect(authMocks.sellerStaffList).not.toHaveBeenCalled();
  });

  it("allows a seller owner to inspect only their own branding staff list", async () => {
    const baseUrl = await startServer();
    const owner = addSession(Role.SELLER, { sellerId: "seller-a" });
    authMocks.sellerLookup.mockResolvedValue({ id: "seller-a" } as never);
    authMocks.sellerStaffList.mockResolvedValue([
      {
        id: "staff-membership-a",
        userId: "staff-a",
        canManageStoreBranding: true,
        canManageShipping: false,
        canManageCurrency: false,
        user: { name: "Synthetic staff", email: "staff@example.test" },
      },
    ] as never);

    const response = await request(
      baseUrl,
      "/api/seller/store-branding/staff",
      { token: owner.token },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      { userId: "staff-a", canManageStoreBranding: true },
    ]);
    expect(authMocks.sellerLookup).toHaveBeenCalledWith({
      where: { id: "seller-a", userId: owner.userId },
      select: { id: true },
    });
  });
});
