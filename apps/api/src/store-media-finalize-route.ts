import crypto from "node:crypto";
import path from "node:path";
import type { Express } from "express";
import sharp from "sharp";
import {
  MediaKind,
  MediaScanStatus,
  MediaUploadStatus,
  Role,
} from "@prisma/client";
import { prisma, requireAuth, requireRole } from "./security.js";
import { storeEntitlements } from "./store-plan-domain.js";
import type { ManagedContentStorage } from "./content-storage.js";
import { authorizedBrandingStore } from "./store-branding-access.js";
import { scanQuarantinedMedia, type MalwareScanner } from "./media-scanner.js";
import { detectStoreMedia } from "./store-media-detection.js";
import {
  activeReservationWhere,
  fail,
  maxBytes,
  param,
  run,
  uploadReservationTtlMs,
  user,
} from "./store-media-shared.js";

export function registerStoreMediaFinalizeRoute(
  app: Express,
  storage: ManagedContentStorage | null,
  scanner: MalwareScanner | null,
  localStorage: ManagedContentStorage | null,
) {
  app.post(
    "/api/seller/store-media/:id/finalize",
    requireAuth,
    requireRole(Role.SELLER, Role.CASHIER),
    run(async (req, res) => {
      const userActor = user(res);
      if (!userActor.sellerId) throw fail(403, "Seller scope required.");
      const store = await authorizedBrandingStore(userActor);
      if (!store)
        throw fail(
          403,
          "An approved Store owner or authorized branding staff member is required.",
        );
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: store.id,
          uploaderId: userActor.id,
          uploadStatus: { in: ["PENDING", "COMPLETE"] },
          storageProvider: { in: ["OBJECT", "LOCAL"] },
        },
      });
      if (!asset) throw fail(404, "Pending upload not found.");
      const assetStorage =
        asset.storageProvider === "OBJECT" ? storage : localStorage;
      if (!assetStorage)
        throw fail(
          503,
          "Managed private media storage is unavailable. The asset remains private.",
        );
      if (asset.uploadStatus === MediaUploadStatus.COMPLETE) {
        return res.json({
          id: asset.id,
          kind: asset.kind,
          detectedMime: asset.detectedMime,
          sizeBytes: asset.sizeBytes,
          width: asset.width,
          height: asset.height,
          scanStatus: asset.scanStatus,
          scanErrorCode: asset.scanErrorCode,
          uploadStatus: asset.uploadStatus,
          publicAfterUpload: false,
          message:
            "This upload was already finalized. Its saved scan state is unchanged.",
        });
      }
      const expiresBefore = new Date(Date.now() - uploadReservationTtlMs);
      if (asset.createdAt < expiresBefore) {
        const expired = await prisma.mediaAsset.updateMany({
          where: {
            id: asset.id,
            storeId: store.id,
            uploaderId: userActor.id,
            uploadStatus: "PENDING",
            createdAt: { lt: expiresBefore },
          },
          data: { uploadStatus: "FAILED" },
        });
        if (expired.count)
          await assetStorage.remove(asset.storageKey).catch(() => undefined);
        throw fail(
          410,
          "This upload reservation expired. Choose the file again to create a fresh upload.",
        );
      }
      let claimed = false;
      let persisted = false;
      const limit = maxBytes(asset.kind);
      let finalKey: string | null = null;
      try {
        const claim = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
          return tx.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              uploadStatus: "PENDING",
              createdAt: { gte: expiresBefore },
            },
            data: { uploadStatus: "VERIFYING" },
          });
        });
        if (claim.count !== 1)
          throw fail(
            409,
            "Upload is already being finalized or is no longer available.",
          );
        claimed = true;
        const head = await assetStorage.head(asset.storageKey);
        if (
          head.ContentLength !== asset.sizeBytes ||
          head.ContentLength > limit ||
          (asset.storageProvider === "OBJECT" &&
            head.ContentType !== asset.detectedMime)
        )
          throw fail(
            400,
            "Uploaded object size or type does not match its reservation.",
          );
        const read = await assetStorage.readLimited(asset.storageKey, limit);
        const extension = path
          .extname(asset.originalName)
          .slice(1)
          .toLowerCase();
        const detected = detectStoreMedia(
          read.bytes,
          extension,
          asset.detectedMime,
        );
        if (
          detected.kind !== asset.kind ||
          read.bytes.length !== asset.sizeBytes
        )
          throw fail(400, "Uploaded object did not match its reservation.");
        let bytes = read.bytes;
        let mime = detected.mime;
        let ext = detected.extension;
        let width: number | undefined;
        let height: number | undefined;
        if (detected.kind === MediaKind.IMAGE) {
          const image = sharp(bytes, {
            limitInputPixels: 40_000_000,
            animated: false,
            failOn: "error",
          });
          const metadata = await image.metadata();
          if (
            !metadata.width ||
            !metadata.height ||
            !["png", "jpeg", "webp", "gif", "heif", "avif"].includes(
              metadata.format ?? "",
            )
          )
            throw fail(415, "Image data could not be safely decoded.");
          width = metadata.width;
          height = metadata.height;
          bytes = await image.rotate().webp({ quality: 86 }).toBuffer();
          mime = "image/webp";
          ext = "webp";
        }
        if (bytes.length > limit)
          throw fail(413, "Normalized file exceeds the configured size limit.");
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Store" WHERE "id" = ${store.id} FOR UPDATE`;
          const [entitlements, reserved] = await Promise.all([
            storeEntitlements(tx, store.id),
            tx.mediaAsset.aggregate({
              where: activeReservationWhere(store.id, expiresBefore, asset.id),
              _sum: { sizeBytes: true },
            }),
          ]);
          const allowance = entitlements.mediaStorageLimitBytes;
          if ((reserved._sum.sizeBytes ?? 0) + bytes.length > allowance)
            throw fail(409, "Your Store has reached its media storage limit.", {
              code: "PLAN_LIMIT_REACHED",
              entitlement: "mediaStorageLimitBytes",
              limit: allowance,
              upgradeRequired: true,
              planUrl: "/seller/plan",
            });
          const changed = await tx.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              uploadStatus: "VERIFYING",
            },
            data: { sizeBytes: bytes.length },
          });
          if (changed.count !== 1)
            throw fail(
              409,
              "Upload was already finalized or is no longer available.",
            );
        });
        finalKey = `stores/${store.id}/media/${asset.id}.${ext}`;
        await assetStorage.put(finalKey, bytes, mime);
        const updated = await prisma.$transaction(async (tx) => {
          const changed = await tx.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              uploadStatus: "VERIFYING",
            },
            data: {
              storageKey: finalKey!,
              uploadStatus: "COMPLETE",
              detectedMime: mime,
              sizeBytes: bytes.length,
              width: width ?? null,
              height: height ?? null,
              durationMs: null,
              checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
              safeName: `${path.parse(asset.safeName).name}.${ext}`,
              scanStatus: MediaScanStatus.QUARANTINED,
            },
          });
          if (changed.count !== 1)
            throw fail(
              409,
              "Upload was already finalized or is no longer available.",
            );
          await tx.auditLog.create({
            data: {
              actorId: userActor.id,
              action: "STORE_MEDIA_UPLOAD_COMPLETED",
              entity: "MediaAsset",
              entityId: asset.id,
              metadata: {
                storeId: store.id,
                kind: asset.kind,
                sizeBytes: bytes.length,
                scanStatus: "QUARANTINED",
              },
            },
          });
          return tx.mediaAsset.findUnique({
            where: { id: asset.id },
            select: {
              id: true,
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
            },
          });
        });
        persisted = true;
        await assetStorage.remove(asset.storageKey).catch(() => undefined);
        const scan = await scanQuarantinedMedia({
          assetId: asset.id,
          bytes,
          scanner,
          actorId: userActor.id,
        });
        res
          .status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202)
          .json({
            ...updated,
            ...scan,
            publicAfterUpload: false,
            message:
              scan.scanStatus === MediaScanStatus.APPROVED
                ? "Upload complete and scanned. It may now be selected for Store content."
                : scan.scanErrorCode === "MALWARE_DETECTED"
                  ? "The scanner rejected this file. It remains private and cannot be used."
                  : "Upload complete, but the file remains private in quarantine until the configured scanner can approve it.",
          });
      } catch (error) {
        if (persisted)
          return res.status(202).json({
            id: asset.id,
            uploadStatus: MediaUploadStatus.COMPLETE,
            scanStatus: MediaScanStatus.QUARANTINED,
            publicAfterUpload: false,
            message:
              "The upload is safely stored in private quarantine, but its scan result could not be confirmed. Retry the scan later.",
          });
        if (finalKey)
          await assetStorage.remove(finalKey).catch(() => undefined);
        // Unknown storage or decoding errors remain retryable until proven unsafe.
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number(error.statusCode)
            : 503;
        if (
          claimed &&
          (statusCode === 400 || statusCode === 413 || statusCode === 415)
        )
          await prisma.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              uploadStatus: "VERIFYING",
            },
            data: { uploadStatus: "FAILED" },
          });
        else if (claimed)
          await prisma.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: store.id,
              uploaderId: userActor.id,
              uploadStatus: "VERIFYING",
            },
            data: { uploadStatus: "PENDING", sizeBytes: asset.sizeBytes },
          });
        if (statusCode === 404) throw error;
        throw statusCode >= 400 && statusCode < 500
          ? error
          : fail(
              503,
              "The upload could not be safely verified. The asset remains unavailable; retry or contact support.",
            );
      }
    }),
  );
}
