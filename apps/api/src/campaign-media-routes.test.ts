import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls = {
    put: vi.fn(
      async (_key: string, _bytes: Buffer, _contentType: string) => undefined,
    ),
    remove: vi.fn(async (_key: string) => undefined),
    readLimited: vi.fn(async (_key: string, _maxBytes: number) => ({
      bytes: Buffer.alloc(0),
      contentLength: 0,
      contentType: null,
    })),
    scan: vi.fn(async () => ({
      id: "asset-test",
      scanStatus: "QUARANTINED",
      scanErrorCode: "SCANNER_UNAVAILABLE",
    })),
    campaignFindUnique: vi.fn(async () => ({
      id: "cm12345678901234567890123",
      status: "ACTIVE",
    })),
    campaignMediaFindMany: vi.fn(
      async () =>
        [] as Array<{ position: number; mediaAsset: { kind: string } }>,
    ),
    mediaAssetCreate: vi.fn(async () => undefined),
    campaignMediaCreate: vi.fn(
      async ({
        data,
      }: {
        data: {
          campaignId: string;
          mediaAssetId: string;
          position: number;
          destinationUrl: string | null;
          altText: string | null;
          buttonLabel: string | null;
        };
      }) => ({
        ...data,
        mediaAsset: {
          id: data.mediaAssetId,
          kind: "IMAGE",
          originalName: "banner.png",
          sizeBytes: 42,
          scanStatus: "QUARANTINED",
          scanErrorCode: "SCANNER_UNAVAILABLE",
          uploadStatus: "COMPLETE",
          detectedMime: "image/webp",
        },
      }),
    ),
    campaignMediaFindUniqueOrThrow: vi.fn(async () => null as unknown),
    campaignMediaDeleteMany: vi.fn(async () => ({ count: 1 })),
    mediaAssetDeleteMany: vi.fn(async () => ({ count: 1 })),
    auditCreate: vi.fn(async () => undefined),
    queryRaw: vi.fn(async () => []),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const tx = {
    $queryRaw: calls.queryRaw,
    marketingCampaign: { findUnique: calls.campaignFindUnique },
    marketingCampaignMedia: {
      findMany: calls.campaignMediaFindMany,
      create: calls.campaignMediaCreate,
    },
    mediaAsset: { create: calls.mediaAssetCreate },
    auditLog: { create: calls.auditCreate },
  };
  const prisma = {
    $transaction: calls.transaction,
    marketingCampaign: { findUnique: calls.campaignFindUnique },
    marketingCampaignMedia: {
      findMany: calls.campaignMediaFindMany,
      create: calls.campaignMediaCreate,
      findUniqueOrThrow: calls.campaignMediaFindUniqueOrThrow,
      deleteMany: calls.campaignMediaDeleteMany,
    },
    mediaAsset: {
      create: calls.mediaAssetCreate,
      deleteMany: calls.mediaAssetDeleteMany,
    },
    auditLog: { create: calls.auditCreate },
  };

  return {
    calls,
    prisma,
    tx,
    storage: {
      put: calls.put,
      remove: calls.remove,
      readLimited: calls.readLimited,
    },
  };
});

vi.mock("./config.js", () => ({
  env: {
    CONTENT_MAX_IMAGE_BYTES: 5_000_000,
    CONTENT_MAX_VIDEO_BYTES: 50_000_000,
  },
}));
vi.mock("./content-storage.js", () => ({
  localContentStorage: mocks.storage,
  objectContentStorage: null,
}));
vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  audit: vi.fn(async () => undefined),
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "user_test_admin",
      role: req.get("x-test-role") ?? "ADMIN",
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
      if (!roles.includes(res.locals.user?.role))
        return res.status(403).json({ error: "Insufficient permissions." });
      next();
    },
}));
vi.mock("./media-scanner.js", () => ({
  malwareScanner: null,
  scanQuarantinedMedia: mocks.calls.scan,
}));

import { registerCampaignMediaRoutes } from "./campaign-media-routes.js";

const campaignId = "cm12345678901234567890123";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAAB5ErkJggg==",
  "base64",
);
const servers: Server[] = [];

async function startServer() {
  const app = express();
  registerCampaignMediaRoutes(app, null);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Campaign media test server did not bind to a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

function upload(
  baseUrl: string,
  options: {
    auth?: string;
    role?: string;
    filename?: string;
    mime?: string;
    bytes?: Buffer;
    destination?: string;
  } = {},
) {
  return fetch(`${baseUrl}/api/admin/campaigns/${campaignId}/media`, {
    method: "POST",
    headers: {
      ...(options.auth ? { "x-test-auth": options.auth } : {}),
      ...(options.role ? { "x-test-role": options.role } : {}),
      "content-type": "application/octet-stream",
      "x-file-name": options.filename ?? "banner.png",
      "x-file-type": options.mime ?? "image/png",
      "x-audit-reason": "Create campaign artwork",
      "x-alt-text": "A seasonal campaign banner",
      ...(options.destination
        ? { "x-destination-url": options.destination }
        : {}),
    },
    body: Uint8Array.from(options.bytes ?? png),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.campaignFindUnique.mockResolvedValue({
    id: campaignId,
    status: "ACTIVE",
  });
  mocks.calls.campaignMediaFindMany.mockResolvedValue([]);
  mocks.calls.campaignMediaCreate.mockImplementation(async ({ data }) => ({
    ...data,
    mediaAsset: {
      id: data.mediaAssetId,
      kind: "IMAGE",
      originalName: "banner.png",
      sizeBytes: 42,
      scanStatus: "QUARANTINED",
      scanErrorCode: "SCANNER_UNAVAILABLE",
      uploadStatus: "COMPLETE",
      detectedMime: "image/webp",
    },
  }));
  mocks.calls.campaignMediaFindUniqueOrThrow.mockImplementation(async () => ({
    campaignId,
    mediaAssetId: "asset-test",
    position: 0,
    destinationUrl: null,
    altText: "A seasonal campaign banner",
    buttonLabel: null,
    mediaAsset: {
      id: "asset-test",
      kind: "IMAGE",
      originalName: "banner.png",
      sizeBytes: 42,
      scanStatus: "QUARANTINED",
      scanErrorCode: "SCANNER_UNAVAILABLE",
      uploadStatus: "COMPLETE",
      detectedMime: "image/webp",
    },
  }));
  mocks.calls.scan.mockResolvedValue({
    id: "asset-test",
    scanStatus: "QUARANTINED",
    scanErrorCode: "SCANNER_UNAVAILABLE",
  });
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

describe("campaign media upload route boundaries", () => {
  it("requires authentication and an authorized content role before accepting an upload", async () => {
    const baseUrl = await startServer();
    expect((await upload(baseUrl)).status).toBe(401);
    expect((await upload(baseUrl, { auth: "yes", role: "BUYER" })).status).toBe(
      403,
    );
    expect(mocks.calls.put).not.toHaveBeenCalled();
  });

  it("rejects unsafe file types and mismatched claimed content before writing storage", async () => {
    const baseUrl = await startServer();
    const unsupported = await upload(baseUrl, {
      auth: "yes",
      filename: "payload.svg",
      mime: "image/svg+xml",
    });
    expect(unsupported.status).toBe(415);

    const mismatch = await upload(baseUrl, {
      auth: "yes",
      filename: "banner.png",
      bytes: Buffer.from('<svg onload="alert(1)">'),
    });
    expect(mismatch.status).toBe(415);
    expect(mocks.calls.put).not.toHaveBeenCalled();
  });

  it("rejects unsafe destinations before storing a valid image", async () => {
    const baseUrl = await startServer();
    const response = await upload(baseUrl, {
      auth: "yes",
      destination: "javascript:alert(1)",
    });
    expect(response.status).toBe(400);
    expect(mocks.calls.put).not.toHaveBeenCalled();
  });

  it("keeps media private and reports pending when scanning is unavailable", async () => {
    const baseUrl = await startServer();
    const response = await upload(baseUrl, {
      auth: "yes",
      destination: "/shop",
    });
    const body = (await response.json()) as {
      media: { scanStatus: string; previewUrl: string };
      message: string;
    };

    expect(response.status).toBe(202);
    expect(body.media.scanStatus).toBe("QUARANTINED");
    expect(body.media.previewUrl).toContain(
      `/api/admin/campaigns/${campaignId}/media/`,
    );
    expect(body.message).toMatch(/saved privately/i);
    expect(mocks.calls.put).toHaveBeenCalledOnce();
    expect(mocks.calls.scan).toHaveBeenCalledWith(
      expect.objectContaining({ scanner: null, bytes: expect.any(Buffer) }),
    );
  });

  it("removes the staged object if adding a seventh image violates the per-campaign limit", async () => {
    mocks.calls.campaignMediaFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, position) => ({
        position,
        mediaAsset: { kind: "IMAGE" },
      })),
    );
    const baseUrl = await startServer();
    const response = await upload(baseUrl, { auth: "yes" });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/up to six images/i);
    expect(mocks.calls.put).toHaveBeenCalledOnce();
    expect(mocks.calls.remove).toHaveBeenCalledOnce();
    expect(mocks.calls.mediaAssetCreate).not.toHaveBeenCalled();
    expect(mocks.calls.scan).not.toHaveBeenCalled();
  });
});
