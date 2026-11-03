import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  const calls = {
    currentUser: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    createReport: vi.fn(),
    liveShoppingState: vi.fn(),
    requireLiveShopping: vi.fn(),
    replayStorageReady: vi.fn(),
    streamReplayObject: vi.fn(),
    issueViewerToken: vi.fn(),
    publicLiveSession: vi.fn(),
  };
  const prisma = {
    liveSession: { findMany: calls.findMany, findFirst: calls.findFirst },
    liveSessionReport: { create: calls.createReport },
  };
  return { calls, prisma };
});

vi.mock("./config.js", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  currentUser: mocks.calls.currentUser,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = { id: req.get("x-test-user-id") ?? "viewer-1" };
    next();
  },
}));
vi.mock("./live-domain.js", () => ({
  liveShoppingState: mocks.calls.liveShoppingState,
  publicLiveSession: mocks.calls.publicLiveSession,
  requireLiveShopping: mocks.calls.requireLiveShopping,
}));
vi.mock("./live-provider.js", () => ({
  liveProvider: { issueViewerToken: mocks.calls.issueViewerToken },
}));
vi.mock("./live-replays.js", () => ({
  liveReplayStorageReady: mocks.calls.replayStorageReady,
  streamReplayObject: mocks.calls.streamReplayObject,
}));

import { registerLivePublicRoutes } from "./live-public-routes.js";

const servers: Server[] = [];
const liveState = {
  deploymentGate: true,
  runtimeEnabled: true,
  effectiveEnabled: true,
  readiness: { configured: true, healthy: true },
  reason: "Live shopping is available.",
};

async function startServer() {
  const app = express();
  app.use(express.json());
  registerLivePublicRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError)
        return res
          .status(400)
          .json({ error: "Validation failed", details: error.flatten() });
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Live public route test server did not bind to TCP.");
  return `http://127.0.0.1:${address.port}`;
}

function request(
  baseUrl: string,
  path: string,
  options: {
    auth?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.liveShoppingState.mockResolvedValue(liveState);
  mocks.calls.requireLiveShopping.mockResolvedValue(liveState);
  mocks.calls.currentUser.mockResolvedValue(null);
  mocks.calls.findMany.mockResolvedValue([]);
  mocks.calls.findFirst.mockResolvedValue(null);
  mocks.calls.createReport.mockResolvedValue({
    id: "report-1",
    status: "PENDING",
  });
  mocks.calls.replayStorageReady.mockReturnValue(false);
  mocks.calls.streamReplayObject.mockImplementation(
    async (_req: unknown, res: express.Response, key: string) =>
      res.status(206).send(`streamed:${key}`),
  );
  mocks.calls.issueViewerToken.mockResolvedValue({ token: "viewer-token" });
  mocks.calls.publicLiveSession.mockImplementation(
    (session: { id: string }) => ({
      id: session.id,
      public: true,
    }),
  );
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

describe("public live-session HTTP routes", () => {
  it("reports provider and recording readiness without exposing provider secrets", async () => {
    mocks.calls.replayStorageReady.mockReturnValue(true);
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/live-shopping/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...liveState,
      recordingAvailable: true,
      recordingStorageConfigured: true,
    });
  });

  it("lists only approved sellers and includes live sessions only when enabled", async () => {
    mocks.calls.liveShoppingState.mockResolvedValue({
      ...liveState,
      effectiveEnabled: false,
    });
    mocks.calls.findMany.mockResolvedValue([{ id: "replay-1", products: [] }]);
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/live-sessions");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "replay-1", public: true }]);
    expect(mocks.calls.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          seller: { is: { status: "APPROVED" } },
          OR: [
            {
              status: "ENDED",
              recordingStatus: "READY",
              replayPublishedAt: { not: null },
            },
          ],
        }),
        take: 50,
      }),
    );
    expect(mocks.calls.publicLiveSession).toHaveBeenCalledWith({
      id: "replay-1",
      products: [],
    });

    mocks.calls.liveShoppingState.mockResolvedValue(liveState);
    await request(baseUrl, "/api/live-sessions");
    expect(mocks.calls.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: { in: ["SCHEDULED", "STARTING", "LIVE", "PAUSED"] },
            }),
          ]),
        }),
      }),
    );
  });

  it("returns public session details with no-store caching and hides unavailable sessions", async () => {
    mocks.calls.findFirst.mockResolvedValue({ id: "show-1", products: [] });
    const baseUrl = await startServer();
    const visible = await request(baseUrl, "/api/live-sessions/show-1");

    expect(visible.status).toBe(200);
    expect(visible.headers.get("cache-control")).toBe("no-store");
    expect(await visible.json()).toEqual({ id: "show-1", public: true });
    expect(mocks.calls.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "show-1",
          deletedAt: null,
          seller: { is: { status: "APPROVED" } },
        }),
      }),
    );

    mocks.calls.findFirst.mockResolvedValue(null);
    const hidden = await request(baseUrl, "/api/live-sessions/hidden");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "Live session not found" });
  });

  it("streams only a published replay and returns 404 otherwise", async () => {
    const baseUrl = await startServer();
    const missing = await request(baseUrl, "/api/live-sessions/show-1/replay");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "Published replay not found.",
    });

    mocks.calls.findFirst.mockResolvedValue({
      recordingStorageKey: "approved/replay.mp4",
    });
    const published = await request(
      baseUrl,
      "/api/live-sessions/show-1/replay",
    );
    expect(published.status).toBe(206);
    expect(await published.text()).toBe("streamed:approved/replay.mp4");
    expect(mocks.calls.streamReplayObject).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ id: "show-1" }),
      }),
      expect.anything(),
      "approved/replay.mp4",
    );
    expect(mocks.calls.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ENDED",
          recordingStatus: "READY",
          replayPublishedAt: { not: null },
          seller: { is: { status: "APPROVED" } },
        }),
      }),
    );
  });

  it("issues an anonymous viewer token with a scoped, secure guest cookie", async () => {
    mocks.calls.findFirst.mockResolvedValue({
      providerSessionRef: "provider-session-1",
    });
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/live-sessions/show-1/token");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: "viewer-token",
      role: "viewer",
    });
    const guestCookie = response.headers.get("set-cookie") ?? "";
    expect(guestCookie).toContain("marketplace_live_viewer=");
    expect(guestCookie).toContain("Path=/api/live-sessions");
    expect(guestCookie).toContain("HttpOnly");
    expect(mocks.calls.issueViewerToken).toHaveBeenCalledWith(
      "provider-session-1",
      expect.stringMatching(/^guest:[a-f0-9]{64}$/),
      "Viewer",
    );

    mocks.calls.currentUser.mockResolvedValue({ id: "viewer-9", name: "Mina" });
    const signedInResponse = await request(
      baseUrl,
      "/api/live-sessions/show-1/token",
    );
    expect(signedInResponse.status).toBe(200);
    expect(signedInResponse.headers.get("set-cookie")).toBeNull();
    expect(mocks.calls.issueViewerToken).toHaveBeenLastCalledWith(
      "provider-session-1",
      "viewer:viewer-9",
      "Mina",
    );
  });

  it("requires authentication, validates reports, and records valid reports", async () => {
    const baseUrl = await startServer();
    const unauthenticated = await request(
      baseUrl,
      "/api/live-sessions/show-1/reports",
      { body: { reason: "Spam" } },
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.calls.findFirst).not.toHaveBeenCalled();

    const invalid = await request(
      baseUrl,
      "/api/live-sessions/show-1/reports",
      { auth: "yes", body: { reason: "x" } },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Validation failed",
      details: expect.any(Object),
    });
    expect(mocks.calls.findFirst).not.toHaveBeenCalled();

    mocks.calls.findFirst.mockResolvedValue({ id: "show-1" });
    const created = await request(
      baseUrl,
      "/api/live-sessions/show-1/reports",
      {
        auth: "yes",
        headers: { "x-test-user-id": "viewer-7" },
        body: { reason: "  Spam content  " },
      },
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "report-1", status: "PENDING" });
    expect(mocks.calls.createReport).toHaveBeenCalledWith({
      data: {
        sessionId: "show-1",
        reporterId: "viewer-7",
        reason: "Spam content",
      },
    });
  });
});
