import crypto from "node:crypto";
import path from "node:path";
import type {
  Express,
  NextFunction,
  Request,
  Response,
  RequestHandler,
} from "express";
import express from "express";
import sharp from "sharp";
import {
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaUploadStatus,
} from "@prisma/client";
import { z } from "zod";
import { env } from "./config.js";
import { prisma } from "./security.js";
import {
  localContentStorage,
  type ManagedContentStorage,
} from "./content-storage.js";
import { detectStoreMedia } from "./store-media-routes.js";
import { scanQuarantinedMedia, type MalwareScanner } from "./media-scanner.js";
import { registerOnboardingExperienceMediaReviewRoutes } from "./onboarding-experience-media-review-routes.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string };
const imageTypes: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};
const uploadTtlMs = 60 * 60 * 1000;

export function registerOnboardingExperienceMediaRoutes(
  app: Express,
  admin: RequestHandler[],
  storage: ManagedContentStorage | null,
  scanner: MalwareScanner | null,
) {
  const localMode = storage === null;
  const activeStorage = storage ?? localContentStorage;

  app.get(
    "/api/admin/platform/onboarding-media",
    ...admin,
    run(async (_req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await prisma.mediaAsset.findMany({
          where: {
            storeId: null,
            purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
            kind: MediaKind.IMAGE,
            storageProvider: { in: ["OBJECT", "LOCAL"] },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true,
            originalName: true,
            safeName: true,
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
        }),
      );
    }),
  );

  app.post(
    "/api/admin/platform/onboarding-media/uploads",
    ...admin,
    run(async (req, res) => {
      const user = actor(res);
      const input = z
        .object({
          fileName: z.string().trim().min(1).max(255),
          contentType: z.string().trim().min(1).max(100),
          sizeBytes: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      const extension = path.extname(input.fileName).slice(1).toLowerCase();
      if (!imageTypes[input.contentType]?.includes(extension))
        throw fail(
          415,
          "Choose a PNG, JPEG, WebP, or GIF image with a matching extension.",
        );
      if (input.sizeBytes > env.CONTENT_MAX_IMAGE_BYTES)
        throw fail(413, "Image exceeds the configured file-size limit.");
      const id = crypto.randomUUID();
      const storageKey = `platform/onboarding-experience/pending/${id}`;
      const asset = await prisma.mediaAsset.create({
        data: {
          id,
          storageKey,
          originalName: input.fileName,
          safeName: input.fileName
            .replace(/[^a-zA-Z0-9._-]/g, "-")
            .slice(0, 120),
          kind: MediaKind.IMAGE,
          detectedMime: input.contentType,
          sizeBytes: input.sizeBytes,
          checksum: crypto
            .createHash("sha256")
            .update(`pending:${id}`)
            .digest("hex"),
          uploaderId: user.id,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          storageProvider: localMode ? "LOCAL" : "OBJECT",
          uploadStatus: MediaUploadStatus.PENDING,
          scanStatus: MediaScanStatus.QUARANTINED,
        },
      });
      try {
        const upload = storage
          ? await storage.createUploadForm(
              storageKey,
              input.contentType,
              input.sizeBytes,
            )
          : {
              url: `/api/admin/platform/onboarding-media/${encodeURIComponent(id)}/local-upload`,
              fields: { "x-local-upload": "1" },
            };
        await prisma.auditLog.create({
          data: {
            actorId: user.id,
            action: "ONBOARDING_EXPERIENCE_MEDIA_UPLOAD_RESERVED",
            entity: "MediaAsset",
            entityId: id,
            metadata: { sizeBytes: input.sizeBytes },
          },
        });
        res.status(201).json({
          id: asset.id,
          upload,
          expiresInSeconds: 300,
          scanStatus: asset.scanStatus,
          publicAfterUpload: false,
        });
      } catch {
        await prisma.mediaAsset.updateMany({
          where: {
            id,
            uploaderId: user.id,
            uploadStatus: MediaUploadStatus.PENDING,
          },
          data: { uploadStatus: MediaUploadStatus.FAILED },
        });
        throw fail(
          503,
          "A temporary upload authorization could not be issued. No image was made public.",
        );
      }
    }),
  );

  app.put(
    "/api/admin/platform/onboarding-media/:id/local-upload",
    ...admin,
    express.raw({ type: "*/*", limit: env.CONTENT_MAX_IMAGE_BYTES }),
    run(async (req, res) => {
      if (!localMode)
        throw fail(
          404,
          "Local onboarding uploads are disabled when managed object storage is enabled.",
        );
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: null,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          uploaderId: actor(res).id,
          storageProvider: "LOCAL",
          uploadStatus: MediaUploadStatus.PENDING,
        },
      });
      if (!asset) throw fail(404, "Pending onboarding image upload not found.");
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType =
        (req.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (
        !bytes.length ||
        bytes.length !== asset.sizeBytes ||
        contentType !== asset.detectedMime
      )
        throw fail(
          400,
          "Uploaded image size or type does not match its reservation.",
        );
      await activeStorage.put(asset.storageKey, bytes, asset.detectedMime);
      res.status(204).send();
    }),
  );

  app.post(
    "/api/admin/platform/onboarding-media/:id/finalize",
    ...admin,
    run(async (req, res) => {
      const user = actor(res);
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: null,
          uploaderId: user.id,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          kind: MediaKind.IMAGE,
          storageProvider: { in: ["OBJECT", "LOCAL"] },
          uploadStatus: {
            in: [MediaUploadStatus.PENDING, MediaUploadStatus.COMPLETE],
          },
        },
      });
      if (!asset) throw fail(404, "Pending onboarding image upload not found.");
      if (asset.uploadStatus === MediaUploadStatus.COMPLETE)
        return res.json({
          id: asset.id,
          scanStatus: asset.scanStatus,
          scanErrorCode: asset.scanErrorCode,
          uploadStatus: asset.uploadStatus,
          publicAfterUpload: false,
          message: "The existing scan state is unchanged.",
        });
      if (asset.createdAt < new Date(Date.now() - uploadTtlMs)) {
        await prisma.mediaAsset.updateMany({
          where: {
            id: asset.id,
            uploaderId: user.id,
            uploadStatus: MediaUploadStatus.PENDING,
          },
          data: { uploadStatus: MediaUploadStatus.FAILED },
        });
        await activeStorage.remove(asset.storageKey).catch(() => undefined);
        throw fail(
          410,
          "Upload authorization expired. Choose the image again to retry.",
        );
      }
      const claim = await prisma.mediaAsset.updateMany({
        where: {
          id: asset.id,
          storeId: null,
          uploaderId: user.id,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          uploadStatus: MediaUploadStatus.PENDING,
        },
        data: { uploadStatus: MediaUploadStatus.VERIFYING },
      });
      if (claim.count !== 1)
        throw fail(
          409,
          "Upload is already being verified or is no longer available.",
        );
      let finalKey: string | null = null;
      let persisted = false;
      try {
        const head = await activeStorage.head(asset.storageKey);
        if (
          head.ContentLength !== asset.sizeBytes ||
          head.ContentLength > env.CONTENT_MAX_IMAGE_BYTES ||
          head.ContentType !== asset.detectedMime
        )
          throw fail(
            400,
            "Uploaded image size or type does not match its reservation.",
          );
        const read = await activeStorage.readLimited(
          asset.storageKey,
          env.CONTENT_MAX_IMAGE_BYTES,
        );
        if (
          read.bytes.length !== asset.sizeBytes ||
          read.contentLength !== asset.sizeBytes ||
          read.contentType !== asset.detectedMime
        )
          throw fail(400, "Image metadata does not match its reservation.");
        const extension = path
          .extname(asset.originalName)
          .slice(1)
          .toLowerCase();
        if (
          detectStoreMedia(read.bytes, extension, asset.detectedMime).kind !==
          MediaKind.IMAGE
        )
          throw fail(415, "Only supported raster images may be used.");
        const image = sharp(read.bytes, {
          limitInputPixels: 40_000_000,
          animated: false,
          failOn: "error",
        });
        const metadata = await image.metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          !["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "")
        )
          throw fail(415, "Image data could not be safely decoded.");
        const normalized = await image
          .rotate()
          .webp({ quality: 86 })
          .toBuffer();
        if (normalized.length > env.CONTENT_MAX_IMAGE_BYTES)
          throw fail(
            413,
            "Normalized image exceeds the configured file-size limit.",
          );
        finalKey = `platform/onboarding-experience/${asset.id}.webp`;
        await activeStorage.put(finalKey, normalized, "image/webp");
        const saved = await prisma.$transaction(async (tx) => {
          const changed = await tx.mediaAsset.updateMany({
            where: {
              id: asset.id,
              storeId: null,
              uploaderId: user.id,
              purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
              uploadStatus: MediaUploadStatus.VERIFYING,
            },
            data: {
              storageKey: finalKey!,
              safeName: `${path.parse(asset.safeName).name}.webp`,
              detectedMime: "image/webp",
              sizeBytes: normalized.length,
              width: metadata.width!,
              height: metadata.height!,
              checksum: crypto
                .createHash("sha256")
                .update(normalized)
                .digest("hex"),
              uploadStatus: MediaUploadStatus.COMPLETE,
              scanStatus: MediaScanStatus.QUARANTINED,
              scanErrorCode: null,
              scanAttemptId: null,
              scanStartedAt: null,
              scanCompletedAt: null,
              scannerProvider: null,
            },
          });
          if (changed.count !== 1)
            throw fail(409, "Upload is no longer available.");
          await tx.auditLog.create({
            data: {
              actorId: user.id,
              action: "ONBOARDING_EXPERIENCE_MEDIA_QUARANTINED",
              entity: "MediaAsset",
              entityId: asset.id,
              metadata: {
                sizeBytes: normalized.length,
                scanStatus: "QUARANTINED",
              },
            },
          });
          return tx.mediaAsset.findUniqueOrThrow({
            where: { id: asset.id },
            select: {
              id: true,
              safeName: true,
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
        await activeStorage.remove(asset.storageKey).catch(() => undefined);
        const scan = await scanQuarantinedMedia({
          assetId: asset.id,
          bytes: normalized,
          scanner,
          actorId: user.id,
        });
        return res
          .status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202)
          .json({
            ...saved,
            ...scan,
            publicAfterUpload: false,
            message:
              scan.scanStatus === MediaScanStatus.APPROVED
                ? "Image normalized and scanned. It remains private until the onboarding draft is published."
                : "Image remains private in quarantine until the malware scanner approves it.",
          });
      } catch (error) {
        if (persisted)
          return res.status(202).json({
            id: asset.id,
            uploadStatus: MediaUploadStatus.COMPLETE,
            scanStatus: MediaScanStatus.QUARANTINED,
            publicAfterUpload: false,
            message:
              "The image is safely stored in private quarantine. Retry the malware scan when available.",
          });
        if (finalKey)
          await activeStorage.remove(finalKey).catch(() => undefined);
        const status =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number(error.statusCode)
            : 503;
        if (status >= 400 && status < 500)
          await activeStorage.remove(asset.storageKey).catch(() => undefined);
        await prisma.mediaAsset.updateMany({
          where: {
            id: asset.id,
            uploaderId: user.id,
            uploadStatus: MediaUploadStatus.VERIFYING,
          },
          data: {
            uploadStatus:
              status >= 400 && status < 500
                ? MediaUploadStatus.FAILED
                : MediaUploadStatus.PENDING,
          },
        });
        if (status >= 400 && status < 500) throw error;
        throw fail(
          503,
          "Image verification or storage failed. The current public onboarding experience remains active.",
        );
      }
    }),
  );

  registerOnboardingExperienceMediaReviewRoutes(app, admin, storage, scanner);
}
