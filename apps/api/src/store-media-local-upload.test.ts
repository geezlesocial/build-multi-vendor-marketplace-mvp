import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls = {
    createdAsset: null as Record<string, unknown> | null,
    assetFindFirst: vi.fn(async () => null as Record<string, unknown> | null),
    assetFindMany: vi.fn(async () => [] as Record<string, unknown>[]),
    assetAggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })),
    assetUpdateMany: vi.fn(async () => ({ count: 1 })),
    assetCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      calls.createdAsset = {
        id: "media-local-1",
        ...data,
        createdAt: new Date(),
      };
      return calls.createdAsset;
    }),
    auditCreate: vi.fn(async () => ({})),
    queryRaw: vi.fn(async () => []),
  };
  const tx = {
    $queryRaw: calls.queryRaw,
    mediaAsset: {
      findMany: calls.assetFindMany,
      aggregate: calls.assetAggregate,
      updateMany: calls.assetUpdateMany,
      create: calls.assetCreate,
    },
    auditLog: { create: calls.auditCreate },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
    mediaAsset: {
      findFirst: calls.assetFindFirst,
      findMany: calls.assetFindMany,
      aggregate: calls.assetAggregate,
      updateMany: calls.assetUpdateMany,
      create: calls.assetCreate,
    },
    auditLog: { create: calls.auditCreate },
  };
  return { calls, prisma };
});

vi.mock("./security.js", () => ({
  prisma: mocks.prisma,
  requireAuth: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-test-auth") !== "yes")
      return res.status(401).json({ error: "Authentication required." });
    res.locals.user = {
      id: "seller-user",
      role: "SELLER",
      sellerId: "seller-1",
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
        return res.status(403).json({ error: "Insufficient role." });
      next();
    },
}));
vi.mock("./store-plan-domain.js", () => ({
  storeEntitlements: vi.fn(async () => ({
    mediaStorageLimitBytes: 10_000_000,
  })),
  effectiveStorePlan: vi.fn(),
}));
vi.mock("./store-branding-access.js", () => ({
  authorizedBrandingStore: vi.fn(async () => ({ id: "store-1" })),
}));
vi.mock("./media-scanner.js", () => ({
  malwareScanner: null,
  scanQuarantinedMedia: vi.fn(),
}));

import { LocalContentStorage } from "./content-storage.js";
import { registerStoreMediaRoutes } from "./store-media-routes.js";

const servers: Server[] = [];

async function startServer(localStorage: LocalContentStorage) {
  const app = express();
  app.use(express.json());
  registerStoreMediaRoutes(app, null, null, localStorage);
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    },
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Store media test server did not bind to a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.createdAsset = null;
  mocks.calls.assetFindFirst.mockResolvedValue(null);
  mocks.calls.assetFindMany.mockResolvedValue([]);
  mocks.calls.assetAggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  mocks.calls.assetUpdateMany.mockResolvedValue({ count: 1 });
  mocks.calls.assetCreate.mockImplementation(async ({ data }) => {
    mocks.calls.createdAsset = {
      id: "media-local-1",
      ...data,
      createdAt: new Date(),
    };
    return mocks.calls.createdAsset;
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

describe("local seller media upload transport", () => {
  it("reserves a private upload and receives its bytes through the authenticated API", async () => {
    const storagePath = await mkdtemp(
      path.join(tmpdir(), "marketplace-media-test-"),
    );
    try {
      const storage = new LocalContentStorage(storagePath);
      const baseUrl = await startServer(storage);
      const bytes = Buffer.from("%PDF-1.7\n", "ascii");
      const reservationResponse = await fetch(
        `${baseUrl}/api/seller/store-media/uploads`,
        {
          method: "POST",
          headers: { "x-test-auth": "yes", "content-type": "application/json" },
          body: JSON.stringify({
            fileName: "sample.pdf",
            contentType: "application/pdf",
            sizeBytes: bytes.length,
          }),
        },
      );
      expect(reservationResponse.status).toBe(201);
      const reservation = (await reservationResponse.json()) as {
        id: string;
        upload: { transport: string; url: string };
        publicAfterUpload: boolean;
      };
      expect(reservation.upload).toMatchObject({
        transport: "LOCAL",
        url: `/api/seller/store-media/${reservation.id}/content`,
      });
      expect(reservation.publicAfterUpload).toBe(false);
      expect(mocks.calls.createdAsset).toMatchObject({
        storageProvider: "LOCAL",
        uploadStatus: "PENDING",
        scanStatus: "QUARANTINED",
      });

      mocks.calls.assetFindFirst.mockImplementation(
        async () => mocks.calls.createdAsset,
      );
      const receiveResponse = await fetch(
        `${baseUrl}${reservation.upload.url}`,
        {
          method: "PUT",
          headers: {
            "x-test-auth": "yes",
            "content-type": "application/octet-stream",
          },
          body: bytes,
        },
      );
      expect(receiveResponse.status).toBe(204);
      expect(mocks.calls.assetFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: reservation.id,
            uploaderId: "seller-user",
            storeId: "store-1",
            uploadStatus: "PENDING",
          }),
        }),
      );
      expect(mocks.calls.assetUpdateMany).toHaveBeenCalledTimes(2);
      expect(
        await storage.readLimited(
          String(mocks.calls.createdAsset?.storageKey),
          bytes.length,
        ),
      ).toMatchObject({ bytes, contentLength: bytes.length });
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });

  it("refuses a local byte upload without authentication", async () => {
    const storagePath = await mkdtemp(
      path.join(tmpdir(), "marketplace-media-test-"),
    );
    try {
      const baseUrl = await startServer(new LocalContentStorage(storagePath));
      const response = await fetch(
        `${baseUrl}/api/seller/store-media/media-local-1/content`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: Buffer.from("private"),
        },
      );
      expect(response.status).toBe(401);
      expect(mocks.calls.assetFindFirst).not.toHaveBeenCalled();
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });
});
