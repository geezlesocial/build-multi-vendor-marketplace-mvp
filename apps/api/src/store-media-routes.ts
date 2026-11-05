import crypto from "node:crypto";
import type { Express } from "express";
import express from "express";
import path from "node:path";
import { MediaKind, MediaScanStatus, MediaUploadStatus, Role } from "@prisma/client";
import { z } from "zod";
import { env } from "./config.js";
import { prisma, requireAuth, requireRole } from "./security.js";
import { effectiveStorePlan, storeEntitlements } from "./store-plan-domain.js";
import { objectContentStorage } from "./content-storage.js";
import type { ManagedContentStorage } from "./content-storage.js";
import { authorizedBrandingStore } from "./store-branding-access.js";
import { malwareScanner, scanQuarantinedMedia, type MalwareScanner } from "./media-scanner.js";
import { localContentStorage } from "./content-storage.js";
import { registerStoreMediaFinalizeRoute } from "./store-media-finalize-route.js";
import { detectStoreMedia, supportedStoreMediaTypes } from "./store-media-detection.js";
import {
  activeReservationWhere,
  fail,
  maxBytes,
  param,
  run,
  uploadReservationTtlMs,
  user,
} from "./store-media-shared.js";

export { detectStoreMedia };

export function registerStoreMediaRoutes(app: Express, storage: ManagedContentStorage | null = objectContentStorage, scanner: MalwareScanner | null = malwareScanner, localStorage: ManagedContentStorage | null = env.NODE_ENV === "production" ? null : localContentStorage) {
  app.post(
    "/api/seller/store-media/uploads",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER),
    run(async (req, res) => {
      const userActor = user(res);
      if (!userActor.sellerId) throw fail(403, "Seller scope required.");
      const input = z
        .object({
          fileName: z.string().trim().min(1).max(255),
          contentType: z.string().trim().min(1).max(100),
          sizeBytes: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      const extension = path.extname(input.fileName).slice(1).toLowerCase();
      const type = supportedStoreMediaTypes[input.contentType];
      if (!type || !type.extensions.includes(extension)) throw fail(415, "Choose a supported image, video, or document file.");
      if (userActor.role === Role.CASHIER && type.kind !== MediaKind.IMAGE) throw fail(403, "Branding staff may upload image assets only.");
      const limit = maxBytes(type.kind);
      if (input.sizeBytes > limit) throw fail(413, "File exceeds the configured per-file size limit.");
      const store = await authorizedBrandingStore(userActor);
      if (!store) throw fail(403, "An approved Store owner or authorized branding staff member is required.");
      if (!storage && !localStorage) throw fail(503, "Managed browser uploads are not configured. The currently published Store image remains active.");
      const id = crypto.randomUUID();
      const temporaryKey = `pending/${store.id}/${id}`;
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
      const media = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
        const stale = await tx.mediaAsset.findMany({
          where: {
            storeId: store.id,
            uploadStatus: { in: ["PENDING", "VERIFYING"] },
            createdAt: { lt: expiresBefore },
          },
          select: { id: true, storageKey: true, storageProvider: true },
        });
        if (stale.length)
          await tx.mediaAsset.updateMany({
            where: {
              id: { in: stale.map((item) => item.id) },
              storeId: store.id,
              uploadStatus: { in: ["PENDING", "VERIFYING"] },
            },
            data: { uploadStatus: "FAILED" },
          });
        const entitlements = await storeEntitlements(tx, store.id);
        const reserved = await tx.mediaAsset.aggregate({
          where: activeReservationWhere(store.id, expiresBefore),
          _sum: { sizeBytes: true },
        });
        const usage = reserved._sum?.sizeBytes ?? 0;
        if (usage + input.sizeBytes > entitlements.mediaStorageLimitBytes)
          throw fail(409, "Your Store has reached its media storage limit.", {
            code: "PLAN_LIMIT_REACHED",
            entitlement: "mediaStorageLimitBytes",
            usage,
            requested: input.sizeBytes,
            limit: entitlements.mediaStorageLimitBytes,
            upgradeRequired: true,
            planUrl: "/seller/plan",
          });
        const asset = await tx.mediaAsset.create({
          data: {
            id,
            storageKey: temporaryKey,
            originalName: input.fileName,
            safeName,
            kind: type.kind,
            detectedMime: input.contentType,
            sizeBytes: input.sizeBytes,
            checksum: crypto.createHash("sha256").update(`pending:${id}`).digest("hex"),
            uploaderId: userActor.id,
            storeId: store.id,
            purpose: "STORE_MEDIA",
            uploadStatus: "PENDING",
            storageProvider: storage ? "OBJECT" : "LOCAL",
            scanStatus: MediaScanStatus.QUARANTINED,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: userActor.id,
            action: "STORE_MEDIA_UPLOAD_RESERVED",
            entity: "MediaAsset",
            entityId: asset.id,
            metadata: {
              storeId: store.id,
              kind: type.kind,
              sizeBytes: input.sizeBytes,
            },
          },
        });
        return {
          asset,
          staleObjects: stale.map(({ storageKey, storageProvider }) => ({
            storageKey,
            storageProvider,
          })),
        };
      });
      await Promise.all(media.staleObjects.map((item) => (item.storageProvider === "OBJECT" ? storage : localStorage)?.remove(item.storageKey).catch(() => undefined)));
      try {
        if (!storage) {
          return res.status(201).json({
            id: media.asset.id,
            upload: {
              transport: "LOCAL",
              url: `/api/seller/store-media/${encodeURIComponent(media.asset.id)}/content`,
              fields: {},
            },
            expiresInSeconds: 300,
            scanStatus: media.asset.scanStatus,
            publicAfterUpload: false,
          });
        }
        const upload = await storage.createUploadForm(media.asset.storageKey, input.contentType, input.sizeBytes);
        res.status(201).json({
          id: media.asset.id,
          upload: { ...upload, transport: "OBJECT" as const },
          expiresInSeconds: 300,
          scanStatus: media.asset.scanStatus,
          publicAfterUpload: false,
        });
      } catch {
        await prisma.mediaAsset.update({
          where: { id: media.asset.id },
          data: { uploadStatus: "FAILED" },
        });
        throw fail(503, "A temporary upload authorization could not be issued. Retry safely.");
      }
    }),
  );

  app.put(
    "/api/seller/store-media/:id/content",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER),
    express.raw({
      type: "application/octet-stream",
      limit: Math.max(env.CONTENT_MAX_IMAGE_BYTES, env.CONTENT_MAX_VIDEO_BYTES, env.CONTENT_MAX_DOCUMENT_BYTES),
    }),
    run(async (req, res) => {
      const userActor = user(res);
      if (!userActor.sellerId) throw fail(403, "Seller scope required.");
      const store = await authorizedBrandingStore(userActor);
      if (!store) throw fail(403, "An approved Store owner or authorized branding staff member is required.");
      if (!localStorage) throw fail(503, "Local media storage is disabled in production. Configure managed uploads before retrying.");
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bytes?.length) throw fail(400, "Choose a non-empty file and retry the upload.");
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: store.id,
          uploaderId: userActor.id,
          storageProvider: "LOCAL",
          purpose: "STORE_MEDIA",
          uploadStatus: "PENDING",
        },
      });
      if (!asset) throw fail(404, "This local upload reservation is unavailable. Choose the file again to create a fresh upload.");
      if (bytes.length !== asset.sizeBytes || bytes.length > maxBytes(asset.kind)) throw fail(400, "The uploaded file size did not match its reservation. Choose the file again.");
      const claim = await prisma.mediaAsset.updateMany({
        where: {
          id: asset.id,
          storeId: store.id,
          uploaderId: userActor.id,
          storageProvider: "LOCAL",
          uploadStatus: "PENDING",
        },
        data: { uploadStatus: "VERIFYING" },
      });
      if (claim.count !== 1) throw fail(409, "This upload is already being received or is no longer available.");
      try {
        await localStorage.put(asset.storageKey, bytes, "application/octet-stream");
        await prisma.auditLog.create({
          data: {
            actorId: userActor.id,
            action: "STORE_MEDIA_UPLOAD_RECEIVED",
            entity: "MediaAsset",
            entityId: asset.id,
            metadata: {
              storeId: store.id,
              kind: asset.kind,
              sizeBytes: bytes.length,
              storageProvider: "LOCAL",
            },
          },
        });
        const saved = await prisma.mediaAsset.updateMany({
          where: {
            id: asset.id,
            storeId: store.id,
            uploaderId: userActor.id,
            storageProvider: "LOCAL",
            uploadStatus: "VERIFYING",
          },
          data: { uploadStatus: "PENDING" },
        });
        if (saved.count !== 1) throw fail(409, "The upload reservation changed while receiving the file.");
        res.status(204).send();
      } catch (error) {
        await localStorage.remove(asset.storageKey).catch(() => undefined);
        await prisma.mediaAsset
          .updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              storageProvider: "LOCAL",
              uploadStatus: "VERIFYING",
            },
            data: { uploadStatus: "PENDING" },
          })
          .catch(() => undefined);
        throw error;
      }
    }),
  );

  app.get(
    "/api/seller/store-media",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER),
    run(async (_req, res) => {
      const userActor = user(res);
      if (!userActor.sellerId) throw fail(403, "Seller scope required.");
      const store = await authorizedBrandingStore(userActor);
      if (!store) throw fail(403, "An approved Store owner or authorized branding staff member is required.");
      const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
      const staleKeys = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
        const stale = await tx.mediaAsset.findMany({
          where: {
            storeId: store.id,
            uploadStatus: { in: ["PENDING", "VERIFYING"] },
            createdAt: { lt: expiresBefore },
          },
          select: { id: true, storageKey: true, storageProvider: true },
        });
        if (stale.length)
          await tx.mediaAsset.updateMany({
            where: {
              id: { in: stale.map((item) => item.id) },
              storeId: store.id,
              uploadStatus: { in: ["PENDING", "VERIFYING"] },
            },
            data: { uploadStatus: "FAILED" },
          });
        return stale.map(({ storageKey, storageProvider }) => ({
          storageKey,
          storageProvider,
        }));
      });
      await Promise.all(staleKeys.map((item) => (item.storageProvider === "OBJECT" ? storage : localStorage)?.remove(item.storageKey).catch(() => undefined)));
      const [effective, usage, assets] = await Promise.all([
        effectiveStorePlan(prisma, store.id),
        prisma.mediaAsset.aggregate({
          where: activeReservationWhere(store.id, expiresBefore),
          _sum: { sizeBytes: true },
        }),
        prisma.mediaAsset.findMany({
          where: {
            storeId: store.id,
            ...(userActor.role === Role.CASHIER ? { kind: MediaKind.IMAGE } : {}),
          },
          select: {
            id: true,
            originalName: true,
            kind: true,
            detectedMime: true,
            sizeBytes: true,
            width: true,
            height: true,
            scanStatus: true,
            scanErrorCode: true,
            scanAttemptCount: true,
            scanCompletedAt: true,
            uploadStatus: true,
            storageProvider: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      ]);
      res.json({
        usedBytes: usage._sum.sizeBytes ?? 0,
        limitBytes: (await storeEntitlements(prisma, store.id, effective.version)).mediaStorageLimitBytes,
        uploadLimitsBytes: {
          IMAGE: env.CONTENT_MAX_IMAGE_BYTES,
          VIDEO: env.CONTENT_MAX_VIDEO_BYTES,
          DOCUMENT: env.CONTENT_MAX_DOCUMENT_BYTES,
        },
        assets,
      });
    }),
  );

  registerStoreMediaFinalizeRoute(app, storage, scanner, localStorage);

  app.post(
    "/api/seller/store-media/:id/scan-retry",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER),
    run(async (req, res) => {
      const userActor = user(res);
      if (!userActor.sellerId) throw fail(403, "Seller scope required.");
      const store = await authorizedBrandingStore(userActor);
      if (!store) throw fail(403, "An approved Store owner or authorized branding staff member is required.");
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: store.id,
          uploadStatus: MediaUploadStatus.COMPLETE,
          scanStatus: MediaScanStatus.QUARANTINED,
          storageProvider: { in: ["OBJECT", "LOCAL"] },
        },
      });
      if (!asset) throw fail(404, "Quarantined Store media not found.");
      if (!scanner) {
        const scan = await scanQuarantinedMedia({
          assetId: asset.id,
          bytes: Buffer.alloc(0),
          scanner,
          actorId: userActor.id,
        });
        return res.status(202).json({
          ...scan,
          message: "The malware scanner is unavailable. The asset remains private.",
        });
      }
      const assetStorage = asset.storageProvider === "OBJECT" ? storage : localStorage;
      if (!assetStorage)
        return res.status(503).json({
          error: "Managed shared storage is unavailable. The asset remains private.",
          code: "MEDIA_STORAGE_UNAVAILABLE",
        });
      try {
        const read = await assetStorage.readLimited(asset.storageKey, maxBytes(asset.kind));
        const scan = await scanQuarantinedMedia({
          assetId: asset.id,
          bytes: read.bytes,
          scanner,
          actorId: userActor.id,
        });
        return res.status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202).json(scan);
      } catch {
        return res.status(503).json({
          error: "The private media object could not be read for scanning. It remains quarantined; retry later.",
          code: "MEDIA_READ_UNAVAILABLE",
        });
      }
    }),
  );
}
