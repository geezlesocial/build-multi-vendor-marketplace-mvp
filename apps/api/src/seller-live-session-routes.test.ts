import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => {
  const makeSession = (overrides: Record<string, unknown> = {}) => ({
    id: "session-synthetic",
    sellerId: "seller-a",
    title: "Synthetic product launch",
    status: "DRAFT",
    scheduledAt: null,
    deletedAt: null,
    providerSessionRef: null,
    playbackRef: null,
    recordingStatus: "NOT_CONFIGURED",
    recordingErrorCode: null,
    recordingEgressId: null,
    recordingStorageKey: null,
    replayPublishedAt: null,
    products: [],
    ...overrides,
  });

  const state = {
    session: makeSession(),
  };
  const canTransition = (from: string, to: string) => {
    const transitions: Record<string, string[]> = {
      DRAFT: ["SCHEDULED", "CANCELLED"],
      SCHEDULED: ["DRAFT", "STARTING", "CANCELLED"],
      STARTING: ["LIVE", "FAILED", "CANCELLED"],
      LIVE: ["PAUSED", "ENDED", "FAILED"],
      PAUSED: ["LIVE", "ENDED", "FAILED"],
      ENDED: [],
      CANCELLED: [],
      FAILED: ["STARTING", "CANCELLED"],
    };
    return from === to || (transitions[from] ?? []).includes(to);
  };
  const calls = {
    findMany: vi.fn(async () => [state.session]),
    findFirst: vi.fn(async () => state.session as unknown),
    findUnique: vi.fn(async () => state.session as unknown),
    create: vi.fn(async () => state.session as unknown),
    updateMany: vi.fn(async () => ({ count: 1 })),
    audit: vi.fn(async (..._args: unknown[]) => undefined),
    eligibleSeller: vi.fn(async (_sellerId: string) => true),
    eligibleProducts: vi.fn(
      async (_sellerId: string, _productIds: string[]) => undefined,
    ),
    requireLiveShopping: vi.fn(async () => ({ effectiveEnabled: true })),
    canTransition: vi.fn(canTransition),
    canDelete: vi.fn(
      (
        status: string,
        recordingStatus: string,
        recordingErrorCode?: string | null,
      ) =>
        !["STARTING", "LIVE", "PAUSED"].includes(status) &&
        !["STARTING", "RECORDING", "PROCESSING"].includes(recordingStatus) &&
        recordingErrorCode !== "SELLER_REPLAY_DELETE_PENDING",
    ),
    createProviderSession: vi.fn(async () => ({
      providerSessionRef: "provider-session-synthetic",
      playbackRef: "https://video.example.test/live.m3u8",
      providerStatus: "READY",
    })),
    endProviderSession: vi.fn(async () => undefined),
    verifyHostPublishing: vi.fn(async () => true),
    issueHostToken: vi.fn(async () => ({ token: "synthetic-host-token" })),
    startRecording: vi.fn(async () => ({
      egressId: "egress-synthetic",
      status: 0,
    })),
    stopRecording: vi.fn(async () => ({ status: 0 })),
    liveReplayStorageReady: vi.fn(() => false),
    reconcileLiveRecordings: vi.fn(async () => undefined),
    removeReplayObject: vi.fn(async (_key: string) => undefined),
    replayObjectExists: vi.fn(async () => true),
    streamReplayObject: vi.fn(async (...args: unknown[]) => {
      const response = args[1] as { send: (body: string) => unknown };
      response.send("synthetic replay");
    }),
    syncLiveShopProducts: vi.fn(async () => undefined),
  };
  const tx = {
    liveSession: {
      updateMany: calls.updateMany,
      findUnique: calls.findUnique,
    },
  };
  const prisma = {
    liveSession: {
      findMany: calls.findMany,
      findFirst: calls.findFirst,
      findUnique: calls.findUnique,
      create: calls.create,
      updateMany: calls.updateMany,
    },
    $transaction: vi.fn(
      async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    ),
  };
  return { calls, canTransition, makeSession, prisma, state };
});

vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  audit: mocks.calls.audit,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    const sellerId = req.get("x-test-seller-id");
    res.locals.user = {
      id: req.get("x-test-user-id") ?? "user-a",
      role: req.get("x-test-role") ?? "SELLER",
      name: "Synthetic Seller",
      ...(sellerId === "__none__" ? {} : { sellerId: sellerId ?? "seller-a" }),
    };
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!roles.includes(res.locals.user?.role ?? ""))
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));
vi.mock("./live-domain.js", () => ({
  eligibleProducts: mocks.calls.eligibleProducts,
  eligibleSeller: mocks.calls.eligibleSeller,
  publicLiveSession: (session: Record<string, unknown>) => {
    const {
      providerSessionRef: _providerSessionRef,
      playbackRef: _playbackRef,
      providerStatus: _providerStatus,
      errorMessage: _errorMessage,
      recordingEgressId: _recordingEgressId,
      recordingStorageKey: _recordingStorageKey,
      recordingErrorCode: _recordingErrorCode,
      ...safe
    } = session;
    return safe;
  },
  canTransitionLiveSession: mocks.calls.canTransition,
  requireLiveShopping: mocks.calls.requireLiveShopping,
}));
vi.mock("./live-state.js", () => ({
  canDeleteLiveShow: mocks.calls.canDelete,
  REPLAY_DELETION_PENDING_ERROR_CODE: "SELLER_REPLAY_DELETE_PENDING",
}));
vi.mock("./live-provider.js", () => ({
  liveProvider: {
    createSession: mocks.calls.createProviderSession,
    endSession: mocks.calls.endProviderSession,
    verifyHostPublishing: mocks.calls.verifyHostPublishing,
    issueHostToken: mocks.calls.issueHostToken,
    startRecording: mocks.calls.startRecording,
    stopRecording: mocks.calls.stopRecording,
  },
}));
vi.mock("./live-replays.js", () => ({
  liveReplayStorageReady: mocks.calls.liveReplayStorageReady,
  reconcileLiveRecordings: mocks.calls.reconcileLiveRecordings,
  removeReplayObject: mocks.calls.removeReplayObject,
  replayObjectExists: mocks.calls.replayObjectExists,
  streamReplayObject: mocks.calls.streamReplayObject,
}));
vi.mock("./live-shop-products.js", () => ({
  syncLiveShopProducts: mocks.calls.syncLiveShopProducts,
}));

import { registerSellerLiveSessionRoutes } from "./seller-live-session-routes.js";

const servers: Server[] = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  registerSellerLiveSessionRoutes(app);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ZodError)
        return res.status(400).json({ error: "Validation failed." });
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Seller live-session test server did not bind to TCP.");
  return `http://127.0.0.1:${address.port}`;
}

function request(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    auth?: string;
    role?: string;
    sellerId?: string;
    body?: unknown;
  } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.role ? { "x-test-role": options.role } : {}),
      ...(options.sellerId ? { "x-test-seller-id": options.sellerId } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

const seller = { auth: "yes", role: "SELLER" };

function setSession(session: ReturnType<typeof mocks.makeSession>) {
  mocks.state.session = session;
  mocks.calls.findFirst.mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.session = mocks.makeSession();
  mocks.calls.findMany.mockResolvedValue([mocks.state.session]);
  mocks.calls.findFirst.mockResolvedValue(mocks.state.session);
  mocks.calls.findUnique.mockResolvedValue(mocks.state.session);
  mocks.calls.create.mockResolvedValue(mocks.state.session);
  mocks.calls.updateMany.mockResolvedValue({ count: 1 });
  mocks.calls.eligibleSeller.mockResolvedValue(true);
  mocks.calls.requireLiveShopping.mockResolvedValue({ effectiveEnabled: true });
  mocks.calls.canTransition.mockImplementation(mocks.canTransition);
  mocks.calls.verifyHostPublishing.mockResolvedValue(true);
  mocks.calls.replayObjectExists.mockResolvedValue(true);
  mocks.calls.liveReplayStorageReady.mockReturnValue(false);
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

describe("seller live-session API ownership and provider gates", () => {
  it("requires an authenticated seller with an explicit seller scope", async () => {
    const baseUrl = await startServer();
    const path = "/api/seller/live-sessions";

    expect((await request(baseUrl, path)).status).toBe(401);
    expect(
      (await request(baseUrl, path, { auth: "yes", role: "BUYER" })).status,
    ).toBe(403);
    expect(
      (await request(baseUrl, path, { ...seller, sellerId: "__none__" }))
        .status,
    ).toBe(403);
    expect(mocks.calls.findMany).not.toHaveBeenCalled();
  });

  it("scopes seller session lists to the authenticated seller", async () => {
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions",
      seller,
    );

    expect(response.status).toBe(200);
    expect(mocks.calls.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          deletedAt: null,
        }),
      }),
    );
  });

  it("rejects unapproved sellers before creating a session", async () => {
    mocks.calls.eligibleSeller.mockResolvedValue(false);
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/seller/live-sessions", {
      ...seller,
      method: "POST",
      body: { title: "New show", timezone: "UTC", productIds: [] },
    });

    expect(response.status).toBe(403);
    expect(mocks.calls.create).not.toHaveBeenCalled();
    expect(mocks.calls.eligibleProducts).not.toHaveBeenCalled();
  });

  it("creates only within the authenticated seller scope after eligibility checks", async () => {
    const baseUrl = await startServer();
    const response = await request(baseUrl, "/api/seller/live-sessions", {
      ...seller,
      method: "POST",
      body: { title: "New show", timezone: "UTC", productIds: [] },
    });

    expect(response.status).toBe(201);
    expect(mocks.calls.eligibleSeller).toHaveBeenCalledWith("seller-a");
    expect(mocks.calls.eligibleProducts).toHaveBeenCalledWith("seller-a", []);
    expect(mocks.calls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: "seller-a",
          status: "DRAFT",
        }),
      }),
    );
  });

  it("does not expose or mutate another seller's session during edits", async () => {
    mocks.calls.findFirst.mockResolvedValue(null);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-owned-by-another-seller",
      { ...seller, method: "PATCH", body: { title: "Attempted takeover" } },
    );

    expect(response.status).toBe(404);
    expect(mocks.calls.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          deletedAt: null,
        }),
      }),
    );
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the live-shopping gate is disabled before provider session creation", async () => {
    setSession(
      mocks.makeSession({
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 60_000),
      }),
    );
    mocks.calls.requireLiveShopping.mockRejectedValue(
      Object.assign(new Error("Live shopping is disabled."), {
        statusCode: 503,
      }),
    );
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/transition",
      { ...seller, method: "POST", body: { status: "STARTING" } },
    );

    expect(response.status).toBe(503);
    expect(mocks.calls.createProviderSession).not.toHaveBeenCalled();
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("ends a newly-created provider room if the database transition loses a race", async () => {
    setSession(
      mocks.makeSession({
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 60_000),
      }),
    );
    mocks.calls.updateMany.mockResolvedValue({ count: 0 });
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/transition",
      { ...seller, method: "POST", body: { status: "STARTING" } },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.createProviderSession).toHaveBeenCalledOnce();
    expect(mocks.calls.endProviderSession).toHaveBeenCalledWith(
      "provider-session-synthetic",
    );
  });

  it("starts a scheduled show only after the provider gate passes", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    setSession(mocks.makeSession({ status: "SCHEDULED", scheduledAt }));
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/transition",
      { ...seller, method: "POST", body: { status: "STARTING" } },
    );

    expect(response.status).toBe(200);
    expect(mocks.calls.createProviderSession).toHaveBeenCalledWith({
      title: "Synthetic product launch",
      scheduledAt,
    });
    expect(mocks.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          status: "SCHEDULED",
        }),
        data: expect.objectContaining({
          status: "STARTING",
          providerSessionRef: "provider-session-synthetic",
        }),
      }),
    );
  });

  it("requires provider-verified host publishing before transitioning live", async () => {
    mocks.state.session = mocks.makeSession({
      status: "STARTING",
      providerSessionRef: "provider-session-synthetic",
    });
    mocks.calls.findFirst.mockResolvedValue(mocks.state.session);
    mocks.calls.verifyHostPublishing.mockResolvedValue(false);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/transition",
      { ...seller, method: "POST", body: { status: "LIVE" } },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.verifyHostPublishing).toHaveBeenCalledWith(
      "provider-session-synthetic",
      "seller:seller-a",
    );
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("issues a host token only for a session in the authenticated seller scope", async () => {
    mocks.calls.findFirst.mockResolvedValue(null);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-owned-by-another-seller/stream-token",
      seller,
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          deletedAt: null,
          providerSessionRef: { not: null },
        }),
      }),
    );
    expect(mocks.calls.issueHostToken).not.toHaveBeenCalled();
  });

  it("issues a host token scoped to the authenticated seller for an owned live session", async () => {
    setSession(
      mocks.makeSession({
        status: "LIVE",
        providerSessionRef: "provider-session-synthetic",
      }),
    );
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/stream-token",
      seller,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: "synthetic-host-token",
      role: "host",
    });
    expect(mocks.calls.issueHostToken).toHaveBeenCalledWith(
      "provider-session-synthetic",
      "seller:seller-a",
      "Synthetic Seller",
    );
  });

  it("does not publish another seller's replay or touch its record", async () => {
    mocks.calls.findFirst.mockResolvedValue(null);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-owned-by-another-seller/replay",
      { ...seller, method: "POST", body: { published: true } },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          deletedAt: null,
        }),
      }),
    );
    expect(mocks.calls.replayObjectExists).not.toHaveBeenCalled();
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("does not publish a replay until its private media object exists", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    mocks.calls.replayObjectExists.mockResolvedValue(false);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "POST", body: { published: true } },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.replayObjectExists).toHaveBeenCalledWith(
      "synthetic/private-replay.mp4",
    );
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("publishes an owned replay only after confirming the private object exists", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "POST", body: { published: true } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "session-synthetic",
      published: true,
    });
    expect(mocks.calls.replayObjectExists).toHaveBeenCalledWith(
      "synthetic/private-replay.mp4",
    );
    expect(mocks.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-a",
          recordingStatus: "READY",
          replayPublishedAt: null,
          recordingStorageKey: "synthetic/private-replay.mp4",
        }),
        data: expect.objectContaining({ replayPublishedAt: expect.any(Date) }),
      }),
    );
    expect(mocks.calls.audit).toHaveBeenCalledWith(
      "user-a",
      "LIVE_REPLAY_PUBLISHED",
      "LiveSession",
      "session-synthetic",
      { published: true },
    );
  });

  it("unpublishes an owned replay without needing the object to be available", async () => {
    const replayPublishedAt = new Date("2026-10-30T10:00:00.000Z");
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
        replayPublishedAt,
      }),
    );
    mocks.calls.replayObjectExists.mockResolvedValue(false);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "POST", body: { published: false } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "session-synthetic",
      published: false,
    });
    expect(mocks.calls.replayObjectExists).not.toHaveBeenCalled();
    expect(mocks.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ replayPublishedAt }),
        data: { replayPublishedAt: null },
      }),
    );
    expect(mocks.calls.audit).toHaveBeenCalledWith(
      "user-a",
      "LIVE_REPLAY_UNPUBLISHED",
      "LiveSession",
      "session-synthetic",
      { published: false },
    );
  });

  it("does not stream a replay unless an owned ended recording is ready", async () => {
    mocks.calls.findFirst.mockResolvedValue(null);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-owned-by-another-seller/replay",
      seller,
    );

    expect(response.status).toBe(404);
    expect(mocks.calls.streamReplayObject).not.toHaveBeenCalled();
  });

  it("claims replay deletion before removing the object and reports a publish race", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    mocks.calls.updateMany.mockResolvedValueOnce({ count: 0 });
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.updateMany).toHaveBeenCalledOnce();
    expect(mocks.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordingStatus: "READY",
          replayPublishedAt: null,
          recordingStorageKey: "synthetic/private-replay.mp4",
        }),
        data: {
          recordingStatus: "FAILED",
          recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
        },
      }),
    );
    expect(mocks.calls.removeReplayObject).not.toHaveBeenCalled();
    expect(mocks.calls.audit).not.toHaveBeenCalled();
  });

  it("removes an unpublished replay after its deletion claim and then clears its key", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(mocks.calls.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.calls.removeReplayObject).toHaveBeenCalledOnce();
    expect(mocks.calls.removeReplayObject).toHaveBeenCalledWith(
      "synthetic/private-replay.mp4",
    );
    expect(mocks.calls.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.calls.removeReplayObject.mock.invocationCallOrder[0]!,
    );
    expect(
      mocks.calls.removeReplayObject.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mocks.calls.updateMany.mock.invocationCallOrder[1]!);
    expect(mocks.calls.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          recordingStatus: "FAILED",
          recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
          recordingStorageKey: "synthetic/private-replay.mp4",
        }),
        data: {
          recordingStatus: "FAILED",
          recordingStorageKey: null,
          recordingErrorCode: "SELLER_DELETED_REPLAY",
        },
      }),
    );
    expect(mocks.calls.audit).toHaveBeenCalledWith(
      "user-a",
      "LIVE_REPLAY_DELETED",
      "LiveSession",
      "session-synthetic",
      {},
    );
  });

  it("retains a retryable claim when storage fails and then completes deletion", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "READY",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    mocks.calls.removeReplayObject.mockRejectedValueOnce(
      new Error("Synthetic storage outage"),
    );
    const baseUrl = await startServer();
    const firstAttempt = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "DELETE" },
    );

    expect(firstAttempt.status).toBe(500);
    expect(mocks.calls.updateMany).toHaveBeenCalledOnce();
    expect(mocks.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordingStatus: "READY",
          recordingStorageKey: "synthetic/private-replay.mp4",
        }),
        data: {
          recordingStatus: "FAILED",
          recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
        },
      }),
    );
    expect(mocks.calls.audit).not.toHaveBeenCalled();

    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "FAILED",
        recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    const retry = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic/replay",
      { ...seller, method: "DELETE" },
    );

    expect(retry.status).toBe(204);
    expect(mocks.calls.removeReplayObject).toHaveBeenCalledTimes(2);
    expect(mocks.calls.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.calls.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          recordingStatus: "FAILED",
          recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
          recordingStorageKey: "synthetic/private-replay.mp4",
        }),
        data: {
          recordingStatus: "FAILED",
          recordingStorageKey: null,
          recordingErrorCode: "SELLER_DELETED_REPLAY",
        },
      }),
    );
  });

  it("prevents deletion while a seller broadcast is active", async () => {
    setSession(mocks.makeSession({ status: "LIVE" }));
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic",
      { ...seller, method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("prevents deleting a show until its pending replay deletion can be retried", async () => {
    setSession(
      mocks.makeSession({
        status: "ENDED",
        recordingStatus: "FAILED",
        recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
        recordingStorageKey: "synthetic/private-replay.mp4",
      }),
    );
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions/session-synthetic",
      { ...seller, method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Finish deleting the replay before deleting this show.",
    });
    expect(mocks.calls.updateMany).not.toHaveBeenCalled();
  });

  it("exposes only a seller retry flag for a pending replay deletion", async () => {
    const pendingSession = mocks.makeSession({
      status: "ENDED",
      recordingStatus: "FAILED",
      recordingErrorCode: "SELLER_REPLAY_DELETE_PENDING",
      recordingStorageKey: "synthetic/private-replay.mp4",
    });
    setSession(pendingSession);
    mocks.calls.findMany.mockResolvedValue([pendingSession]);
    const baseUrl = await startServer();
    const response = await request(
      baseUrl,
      "/api/seller/live-sessions",
      seller,
    );
    const [session] = (await response.json()) as Record<string, unknown>[];

    expect(response.status).toBe(200);
    expect(session).toMatchObject({
      id: "session-synthetic",
      replayDeletionPending: true,
    });
    expect(session).not.toHaveProperty("recordingErrorCode");
    expect(session).not.toHaveProperty("recordingStorageKey");
  });
});
