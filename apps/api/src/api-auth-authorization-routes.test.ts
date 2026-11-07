import { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  addSession,
  authMocks,
  request,
  setAccountStatus,
  startServer,
} from "../test-support/api-auth-test-fixtures.js";

describe("HTTP authentication and authorization boundaries", () => {
  it("rejects missing, bearer-only, unknown, expired, and revoked sessions", async () => {
    const baseUrl = await startServer();
    const route = "/api/admin/auth/social/providers";

    expect((await request(baseUrl, route)).status).toBe(401);
    expect(
      (
        await request(baseUrl, route, {
          authorization: "Bearer synthetic-invalid-token",
        })
      ).status,
    ).toBe(401);

    expect(
      (await request(baseUrl, route, { token: "unknown-session-token" }))
        .status,
    ).toBe(401);

    const expired = addSession(Role.ADMIN, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(
      (await request(baseUrl, route, { token: expired.token })).status,
    ).toBe(401);

    expect(authMocks.sessionLookup).toHaveBeenCalled();
    expect(authMocks.socialProviderList).not.toHaveBeenCalled();
  });

  it("invalidates sessions for inactive accounts without exposing account state", async () => {
    const baseUrl = await startServer();
    const session = addSession(Role.ADMIN);
    setAccountStatus("SUSPENDED");

    const response = await request(
      baseUrl,
      "/api/admin/auth/social/providers",
      { token: session.token },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required",
    });
    expect(authMocks.sessionDelete).toHaveBeenCalledWith({
      where: { userId: session.userId },
    });
    expect(authMocks.socialProviderList).not.toHaveBeenCalled();
  });

  it("revokes a valid session on logout and rejects the same credential afterward", async () => {
    const baseUrl = await startServer();
    const admin = addSession(Role.ADMIN);

    const logout = await request(baseUrl, "/api/auth/logout", {
      method: "POST",
      token: admin.token,
      csrfCookie: "matching-csrf-value",
      csrfHeader: "matching-csrf-value",
    });
    expect(logout.status).toBe(204);
    expect(authMocks.sessionDelete).toHaveBeenCalledWith({
      where: { tokenHash: authMocks.tokenHash(admin.token) },
    });

    const reused = await request(baseUrl, "/api/admin/auth/social/providers", {
      token: admin.token,
    });
    expect(reused.status).toBe(401);
    expect(authMocks.socialProviderList).not.toHaveBeenCalled();
  });

  it("requires completed onboarding before privileged API access", async () => {
    const baseUrl = await startServer();
    const session = addSession(Role.ADMIN, { onboardingCompletedAt: null });

    const response = await request(
      baseUrl,
      "/api/admin/auth/social/providers",
      { token: session.token },
    );

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      code: "ONBOARDING_REQUIRED",
      redirectTo: "/onboarding",
    });
    expect(authMocks.socialProviderList).not.toHaveBeenCalled();
  });

  it("denies buyer, seller, and limited platform-staff sessions at admin routes", async () => {
    const baseUrl = await startServer();

    for (const role of [Role.BUYER, Role.SELLER, Role.PLATFORM_STAFF]) {
      const session = addSession(role);
      const response = await request(
        baseUrl,
        "/api/admin/auth/social/providers",
        { token: session.token },
      );
      expect(response.status, role).toBe(403);
      expect(await response.json()).toEqual({
        error: "Insufficient permissions",
      });
    }

    expect(authMocks.socialProviderList).not.toHaveBeenCalled();
  });

  it("enforces CSRF before auth and role checks on unsafe requests", async () => {
    const baseUrl = await startServer();
    const admin = addSession(Role.ADMIN);
    const buyer = addSession(Role.BUYER);
    const route = "/api/admin/auth/social/providers/FACEBOOK";
    const body = { enabled: false };

    const csrfRejected = await request(baseUrl, route, {
      method: "PUT",
      token: admin.token,
      csrfCookie: "csrf-cookie-value",
      csrfHeader: "different-header-value",
      body,
    });
    expect(csrfRejected.status).toBe(403);
    expect(await csrfRejected.json()).toEqual({
      error: "CSRF validation failed",
    });
    expect(authMocks.sessionLookup).not.toHaveBeenCalled();

    const roleRejected = await request(baseUrl, route, {
      method: "PUT",
      token: buyer.token,
      csrfCookie: "matching-csrf-value",
      csrfHeader: "matching-csrf-value",
      body,
    });
    expect(roleRejected.status).toBe(403);
    expect(authMocks.socialProviderLookup).not.toHaveBeenCalled();
    expect(authMocks.socialProviderSave).not.toHaveBeenCalled();
  });

  it("allows an admin to read provider configuration without returning secrets", async () => {
    const baseUrl = await startServer();
    const admin = addSession(Role.ADMIN);
    const ciphertext = "stored-ciphertext-synthetic-only";
    authMocks.socialProviderList.mockResolvedValue([
      {
        provider: "GOOGLE",
        enabled: true,
        clientId: "synthetic-client-id-123456",
        clientSecretCiphertext: ciphertext,
        issuerUrl: null,
        logoUrl: null,
      },
    ] as never);

    const response = await request(
      baseUrl,
      "/api/admin/auth/social/providers",
      { token: admin.token },
    );
    const payload = await response.json();
    const encoded = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.providers).toContainEqual(
      expect.objectContaining({
        id: "GOOGLE",
        clientSecretConfigured: true,
      }),
    );
    expect(encoded).not.toContain(ciphertext);
    expect(encoded).not.toContain("clientSecretCiphertext");
  });

  it("stores an admin-supplied social credential encrypted and omits it from responses and audit metadata", async () => {
    const baseUrl = await startServer();
    const admin = addSession(Role.ADMIN);
    const secret = "synthetic-social-provider-secret-not-real";

    const response = await request(
      baseUrl,
      "/api/admin/auth/social/providers/FACEBOOK",
      {
        method: "PUT",
        token: admin.token,
        csrfCookie: "matching-csrf-value",
        csrfHeader: "matching-csrf-value",
        body: {
          enabled: false,
          clientId: "synthetic-facebook-client-id",
          clientSecret: secret,
        },
      },
    );
    const payload = await response.json();
    const encoded = JSON.stringify(payload);
    const persistedSecret =
      authMocks.socialProviderSave.mock.calls[0]?.[0].create
        .clientSecretCiphertext;
    const auditMetadata =
      authMocks.auditCreate.mock.calls[0]?.[0].data.metadata;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      provider: "FACEBOOK",
      enabled: false,
      configured: true,
      clientSecretConfigured: true,
    });
    expect(typeof persistedSecret).toBe("string");
    expect(persistedSecret).not.toBe(secret);
    expect(persistedSecret?.split(".")).toHaveLength(3);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(persistedSecret);
    expect(JSON.stringify(auditMetadata)).not.toContain(secret);
    expect(JSON.stringify(auditMetadata)).toContain("secretChanged");
  });

  it("rejects unexpected provider-update fields without persisting or echoing the request", async () => {
    const baseUrl = await startServer();
    const admin = addSession(Role.ADMIN);
    const secret = "synthetic-secret-in-invalid-payload";

    const response = await request(
      baseUrl,
      "/api/admin/auth/social/providers/FACEBOOK",
      {
        method: "PUT",
        token: admin.token,
        csrfCookie: "matching-csrf-value",
        csrfHeader: "matching-csrf-value",
        body: { enabled: false, clientSecret: secret, unexpected: "extra" },
      },
    );
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).not.toContain(secret);
    expect(authMocks.socialProviderSave).not.toHaveBeenCalled();
    expect(authMocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a social callback with a mismatched state cookie before database or provider access", async () => {
    const baseUrl = await startServer();
    const state = "a".repeat(32);
    const response = await request(
      baseUrl,
      `/api/auth/social/google/callback?state=${state}`,
      { extraCookies: [`oauth_state_${state.slice(0, 16)}=${"b".repeat(32)}`] },
    );

    expect(response.status).toBe(303);
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get(
        "social_error",
      ),
    ).toBe("try_again");
    expect(authMocks.oauthAttemptLookup).not.toHaveBeenCalled();
  });
});
