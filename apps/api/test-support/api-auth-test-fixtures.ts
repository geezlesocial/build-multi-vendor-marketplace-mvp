import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, vi } from "vitest";
import { Role } from "@prisma/client";
import { app } from "../src/index.js";
import { env } from "../src/config.js";
import { prisma, tokenHash } from "../src/security.js";

const sessions = new Map<string, unknown>();
const revokedSessions = new Set<string>();
let accountStatus = "ACTIVE";

export function setAccountStatus(status: string) {
  accountStatus = status;
}
const sessionLookup = vi.spyOn(prisma.session, "findUnique");
const sessionDelete = vi.spyOn(prisma.session, "deleteMany");
const accountLookup = vi.spyOn(prisma, "$queryRaw");
const officialStoreLookup = vi.spyOn(prisma.store, "findFirst");
const brandingLookup = vi.spyOn(prisma.platformBranding, "findUnique");
const socialProviderList = vi.spyOn(
  prisma.socialLoginProviderConfiguration,
  "findMany",
);
const socialProviderLookup = vi.spyOn(
  prisma.socialLoginProviderConfiguration,
  "findUnique",
);
const socialProviderSave = vi.spyOn(
  prisma.socialLoginProviderConfiguration,
  "upsert",
);
const auditCreate = vi.spyOn(prisma.auditLog, "create");
const oauthAttemptLookup = vi.spyOn(prisma.oAuthLoginAttempt, "findUnique");
const sellerLookup = vi.spyOn(prisma.seller, "findFirst");
const sellerStaffLookup = vi.spyOn(prisma.sellerStaff, "findFirst");
const sellerStaffList = vi.spyOn(prisma.sellerStaff, "findMany");
export const authMocks = {
  sessionLookup,
  sessionDelete,
  accountLookup,
  officialStoreLookup,
  brandingLookup,
  socialProviderList,
  socialProviderLookup,
  socialProviderSave,
  auditCreate,
  oauthAttemptLookup,
  sellerLookup,
  sellerStaffLookup,
  sellerStaffList,
  tokenHash,
};

const servers: Server[] = [];

export function addSession(
  role: Role,
  options: {
    expiresAt?: Date;
    onboardingCompletedAt?: Date | null;
    sellerId?: string;
    staffSellerId?: string;
  } = {},
) {
  const token = `session-${role.toLowerCase()}-${sessions.size + 1}`;
  const userId = `user-${role.toLowerCase()}-${sessions.size + 1}`;
  const staffMemberships = options.staffSellerId
    ? [{ sellerId: options.staffSellerId }]
    : [];
  const session = {
    id: `session-record-${sessions.size + 1}`,
    userId,
    tokenHash: tokenHash(token),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
    user: {
      id: userId,
      email: `${userId}@example.test`,
      name: `Synthetic ${role}`,
      role,
      emailVerifiedAt: new Date(),
      onboardingCompletedAt:
        options.onboardingCompletedAt === undefined
          ? new Date()
          : options.onboardingCompletedAt,
      avatarMediaId: null,
      seller: options.sellerId ? { id: options.sellerId } : null,
      staffMemberships,
      platformCollaborator:
        role === Role.PLATFORM_STAFF
          ? {
              enabled: true,
              position: "ACCOUNTANT",
              permissions: ["MARKETPLACE"],
            }
          : null,
    },
  };
  sessions.set(tokenHash(token), session);
  return { token, userId };
}

export async function startServer() {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("API authorization test server did not bind to TCP.");
  return `http://127.0.0.1:${address.port}`;
}

export function request(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    csrfCookie?: string;
    csrfHeader?: string;
    extraCookies?: string[];
    authorization?: string;
    body?: unknown;
  } = {},
) {
  const cookies = [
    ...(options.token ? [`${env.SESSION_COOKIE_NAME}=${options.token}`] : []),
    ...(options.csrfCookie ? [`marketplace_csrf=${options.csrfCookie}`] : []),
    ...(options.extraCookies ?? []),
  ];
  const headers: Record<string, string> = {};
  if (cookies.length) headers.cookie = cookies.join("; ");
  if (options.csrfHeader) headers["x-csrf-token"] = options.csrfHeader;
  if (options.authorization) headers.authorization = options.authorization;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    redirect: "manual",
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

beforeEach(() => {
  sessions.clear();
  revokedSessions.clear();
  accountStatus = "ACTIVE";
  sessionLookup.mockReset().mockImplementation((async (args?: {
    where?: { tokenHash?: unknown };
  }) => {
    const token = args?.where?.tokenHash;
    return typeof token === "string" && !revokedSessions.has(token)
      ? sessions.get(token)
      : undefined;
  }) as never);
  sessionDelete.mockReset().mockImplementation((async (args?: {
    where?: { tokenHash?: unknown };
  }) => {
    const token = args?.where?.tokenHash;
    if (typeof token === "string") {
      sessions.delete(token);
      revokedSessions.add(token);
    }
    return { count: 1 };
  }) as never);
  accountLookup
    .mockReset()
    .mockImplementation((async () => [{ accountStatus }]) as never);
  officialStoreLookup.mockReset().mockResolvedValue(null);
  brandingLookup.mockReset().mockResolvedValue(null);
  socialProviderList.mockReset().mockResolvedValue([]);
  socialProviderLookup.mockReset().mockResolvedValue(null);
  socialProviderSave.mockReset().mockResolvedValue({
    id: "synthetic-provider-config",
    provider: "FACEBOOK",
    enabled: false,
    clientId: "synthetic-client-id",
    clientSecretCiphertext: "synthetic-encrypted-provider-secret",
    issuerUrl: null,
    logoUrl: null,
  } as never);
  auditCreate
    .mockReset()
    .mockResolvedValue({ id: "synthetic-audit-entry" } as never);
  oauthAttemptLookup.mockReset().mockResolvedValue(null);
  sellerLookup.mockReset().mockResolvedValue(null);
  sellerStaffLookup.mockReset().mockResolvedValue(null);
  sellerStaffList.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
