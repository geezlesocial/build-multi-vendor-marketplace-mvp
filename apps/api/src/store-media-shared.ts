import type { NextFunction, Request, Response } from "express";
import express from "express";
import { MediaKind, MediaUploadStatus, Role } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { env } from "./config.js";

export const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

export const param = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export const fail = (
  statusCode: number,
  message: string,
  extra?: Record<string, unknown>,
) => Object.assign(new Error(message), { statusCode, ...extra });

export const user = (res: Response) =>
  res.locals.user as { id: string; role: Role; sellerId?: string };

export function maxBytes(kind: MediaKind) {
  return kind === MediaKind.IMAGE
    ? env.CONTENT_MAX_IMAGE_BYTES
    : kind === MediaKind.VIDEO
      ? env.CONTENT_MAX_VIDEO_BYTES
      : env.CONTENT_MAX_DOCUMENT_BYTES;
}

export const uploadReservationTtlMs = 60 * 60 * 1000;

export const activeReservationWhere = (
  storeId: string,
  since: Date,
  exceptId?: string,
): Prisma.MediaAssetWhereInput => ({
  storeId,
  ...(exceptId ? { id: { not: exceptId } } : {}),
  OR: [
    { uploadStatus: MediaUploadStatus.COMPLETE },
    {
      uploadStatus: {
        in: [MediaUploadStatus.PENDING, MediaUploadStatus.VERIFYING],
      },
      createdAt: { gte: since },
    },
  ],
});
