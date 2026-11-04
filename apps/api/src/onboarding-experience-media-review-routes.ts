import type {
  Express,
  NextFunction,
  Request,
  Response,
  RequestHandler,
} from "express";
import {
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaUploadStatus,
} from "@prisma/client";
import { env } from "./config.js";
import { prisma } from "./security.js";
import {
  localContentStorage,
  type ManagedContentStorage,
} from "./content-storage.js";
import { scanQuarantinedMedia, type MalwareScanner } from "./media-scanner.js";

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

export function registerOnboardingExperienceMediaReviewRoutes(
  app: Express,
  admin: RequestHandler[],
  storage: ManagedContentStorage | null,
  scanner: MalwareScanner | null,
) {
  const activeStorage = storage ?? localContentStorage;

  app.post(
    "/api/admin/platform/onboarding-media/:id/scan-retry",
    ...admin,
    run(async (req, res) => {
      const user = actor(res);
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: null,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          kind: MediaKind.IMAGE,
          uploadStatus: MediaUploadStatus.COMPLETE,
          scanStatus: MediaScanStatus.QUARANTINED,
          storageProvider: { in: ["OBJECT", "LOCAL"] },
        },
      });
      if (!asset) throw fail(404, "Quarantined onboarding image not found.");
      if (!scanner)
        return res.status(202).json(
          await scanQuarantinedMedia({
            assetId: asset.id,
            bytes: Buffer.alloc(0),
            scanner,
            actorId: user.id,
          }),
        );
      try {
        const read = await activeStorage.readLimited(
          asset.storageKey,
          env.CONTENT_MAX_IMAGE_BYTES,
        );
        const scan = await scanQuarantinedMedia({
          assetId: asset.id,
          bytes: read.bytes,
          scanner,
          actorId: user.id,
        });
        return res
          .status(scan.scanStatus === MediaScanStatus.APPROVED ? 200 : 202)
          .json(scan);
      } catch {
        return res.status(503).json({
          error:
            "The image remains private and quarantined; retry scanning later.",
          code: "MEDIA_READ_UNAVAILABLE",
        });
      }
    }),
  );

  app.get(
    "/api/admin/platform/onboarding-media/:id/preview",
    ...admin,
    run(async (req, res) => {
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: param(req.params.id),
          storeId: null,
          purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
          kind: MediaKind.IMAGE,
          uploadStatus: MediaUploadStatus.COMPLETE,
          scanStatus: { not: MediaScanStatus.REJECTED },
        },
      });
      if (!asset)
        return res.status(404).json({ error: "Onboarding image not found." });
      if (asset.storageProvider === "OBJECT" && !storage)
        throw fail(503, "Managed shared storage is unavailable.");
      res.set({
        "Content-Type": asset.detectedMime,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      activeStorage
        .open(asset.storageKey)
        .on("error", () => {
          if (!res.headersSent) res.status(404).end();
        })
        .pipe(res);
    }),
  );
}
