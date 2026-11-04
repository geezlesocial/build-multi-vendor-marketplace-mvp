import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import {
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaUploadStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { z } from "zod";
import { prisma, requireAuth, requireRole } from "./security.js";
import {
  defaultOnboardingExperience,
  onboardingExperienceSchema,
  type OnboardingExperience,
} from "./onboarding-experience-domain.js";
import {
  objectContentStorage,
  type ManagedContentStorage,
} from "./content-storage.js";
import { malwareScanner, type MalwareScanner } from "./media-scanner.js";
import { registerOnboardingExperienceMediaRoutes } from "./onboarding-experience-media-routes.js";

const run =
  (
    handler: (req: Request, res: Response, next: NextFunction) => unknown,
  ): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const actor = (res: Response) => res.locals.user as { id: string };
const jsonInput = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const versionInput = z
  .object({ expectedVersion: z.number().int().min(0).max(2_000_000_000) })
  .strict();
const saveInput = versionInput
  .extend({
    configuration: onboardingExperienceSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
const mediaIds = (configuration: OnboardingExperience) => [
  ...new Set(
    [
      configuration.welcome.logoMediaId,
      configuration.welcome.heroMediaId,
    ].filter((id): id is string => Boolean(id)),
  ),
];

async function validateMedia(
  configuration: OnboardingExperience,
  publish: boolean,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const ids = mediaIds(configuration);
  if (!ids.length) return;
  const assets = await tx.mediaAsset.findMany({
    where: {
      id: { in: ids },
      storeId: null,
      purpose: MediaPurpose.ONBOARDING_EXPERIENCE,
      kind: MediaKind.IMAGE,
      uploadStatus: MediaUploadStatus.COMPLETE,
    },
    select: { id: true, scanStatus: true },
  });
  if (assets.length !== ids.length)
    throw fail(
      400,
      "An onboarding image is unavailable or belongs to another media library.",
    );
  if (assets.some((asset) => asset.scanStatus === MediaScanStatus.REJECTED))
    throw fail(
      409,
      "Rejected onboarding images cannot be used. Choose a different image.",
    );
  if (
    publish &&
    assets.some((asset) => asset.scanStatus !== MediaScanStatus.APPROVED)
  )
    throw fail(
      409,
      "Every onboarding image must pass malware scanning before publication.",
    );
  if (
    configuration.welcome.logoMediaId &&
    !configuration.welcome.logoAlt.trim()
  )
    throw fail(400, "Provide alternative text for the onboarding logo.");
  if (
    configuration.welcome.heroMediaId &&
    !configuration.welcome.heroAlt.trim()
  )
    throw fail(400, "Provide alternative text for the onboarding hero image.");
}

async function writeDraft(
  configuration: OnboardingExperience,
  expectedVersion: number,
  editorId: string,
  reason: string,
  action = "ONBOARDING_EXPERIENCE_DRAFT_SAVED",
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('onboarding-experience', 194821))`;
    await validateMedia(configuration, false, tx);
    const current = await tx.onboardingExperience.findUnique({
      where: { id: "default" },
      select: { draftVersion: true },
    });
    if ((current?.draftVersion ?? 0) !== expectedVersion)
      throw fail(
        409,
        "The onboarding draft changed in another session. Reload the current version before saving.",
      );
    const version = expectedVersion + 1;
    const json = jsonInput(configuration);
    const saved = await tx.onboardingExperience.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        draftJson: json,
        draftVersion: version,
        updatedById: editorId,
      },
      update: { draftJson: json, draftVersion: version, updatedById: editorId },
    });
    await tx.onboardingExperienceRevision.create({
      data: {
        configurationId: "default",
        version,
        configurationJson: json,
        editorId,
        changeNote: reason.slice(0, 500) || null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: editorId,
        action,
        entity: "OnboardingExperience",
        entityId: "default",
        metadata: { version },
      },
    });
    return saved;
  });
}

export function registerOnboardingExperienceRoutes(
  app: Express,
  storage: ManagedContentStorage | null = objectContentStorage,
  scanner: MalwareScanner | null = malwareScanner,
) {
  const admin = [requireAuth, requireRole(Role.ADMIN)];
  app.get(
    "/api/admin/onboarding/experience",
    ...admin,
    run(async (_req, res) => {
      const [record, revisions] = await Promise.all([
        prisma.onboardingExperience.findUnique({ where: { id: "default" } }),
        prisma.onboardingExperienceRevision.findMany({
          where: { configurationId: "default" },
          orderBy: { version: "desc" },
          take: 50,
          select: {
            version: true,
            changeNote: true,
            createdAt: true,
            editor: { select: { id: true, name: true, email: true } },
          },
        }),
      ]);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        draft: record
          ? onboardingExperienceSchema.parse(record.draftJson)
          : defaultOnboardingExperience,
        published: record?.publishedJson
          ? (onboardingExperienceSchema.safeParse(record.publishedJson).data ??
            null)
          : null,
        draftVersion: record?.draftVersion ?? 0,
        publishedVersion: record?.publishedVersion ?? null,
        publishedAt: record?.publishedAt ?? null,
        revisions,
      });
    }),
  );

  app.put(
    "/api/admin/onboarding/experience/draft",
    ...admin,
    run(async (req, res) => {
      const input = saveInput.parse(req.body);
      const saved = await writeDraft(
        input.configuration,
        input.expectedVersion,
        actor(res).id,
        input.reason ?? "Saved onboarding experience draft",
      );
      res.json({
        draft: onboardingExperienceSchema.parse(saved.draftJson),
        draftVersion: saved.draftVersion,
        updatedAt: saved.updatedAt,
      });
    }),
  );

  app.post(
    "/api/admin/onboarding/experience/publish",
    ...admin,
    run(async (req, res) => {
      const { expectedVersion } = versionInput.parse(req.body);
      const editorId = actor(res).id;
      const published = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('onboarding-experience', 194821))`;
        const current = await tx.onboardingExperience.findUnique({
          where: { id: "default" },
        });
        if (!current)
          throw fail(404, "Save an onboarding draft before publishing.");
        if (current.draftVersion !== expectedVersion)
          throw fail(
            409,
            "The onboarding draft changed. Reload it before publishing.",
          );
        const configuration = onboardingExperienceSchema.parse(
          current.draftJson,
        );
        await validateMedia(configuration, true, tx);
        const updated = await tx.onboardingExperience.update({
          where: { id: "default" },
          data: {
            publishedJson: jsonInput(configuration),
            publishedVersion: expectedVersion,
            publishedAt: new Date(),
            updatedById: editorId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: editorId,
            action: "ONBOARDING_EXPERIENCE_PUBLISHED",
            entity: "OnboardingExperience",
            entityId: "default",
            metadata: { version: expectedVersion },
          },
        });
        return updated;
      });
      res.json({
        published: onboardingExperienceSchema.parse(published.publishedJson),
        publishedVersion: published.publishedVersion,
        publishedAt: published.publishedAt,
      });
    }),
  );

  app.post(
    "/api/admin/onboarding/experience/reset",
    ...admin,
    run(async (req, res) => {
      const { expectedVersion } = versionInput.parse(req.body);
      const saved = await writeDraft(
        defaultOnboardingExperience,
        expectedVersion,
        actor(res).id,
        "Reset to the safe default onboarding experience",
        "ONBOARDING_EXPERIENCE_RESET",
      );
      res.json({
        draft: onboardingExperienceSchema.parse(saved.draftJson),
        draftVersion: saved.draftVersion,
        updatedAt: saved.updatedAt,
      });
    }),
  );

  app.post(
    "/api/admin/onboarding/experience/revisions/:version/restore",
    ...admin,
    run(async (req, res) => {
      const { expectedVersion } = versionInput.parse(req.body);
      const revisionVersion = Number(
        Array.isArray(req.params.version)
          ? req.params.version[0]
          : req.params.version,
      );
      if (!Number.isInteger(revisionVersion) || revisionVersion < 1)
        throw fail(400, "Invalid onboarding revision.");
      const editorId = actor(res).id;
      const restored = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('onboarding-experience', 194821))`;
        const current = await tx.onboardingExperience.findUnique({
          where: { id: "default" },
          select: { draftVersion: true },
        });
        if ((current?.draftVersion ?? 0) !== expectedVersion)
          throw fail(
            409,
            "The onboarding draft changed. Reload it before restoring a revision.",
          );
        const revision = await tx.onboardingExperienceRevision.findUnique({
          where: {
            configurationId_version: {
              configurationId: "default",
              version: revisionVersion,
            },
          },
        });
        if (!revision) throw fail(404, "Onboarding revision not found.");
        const configuration = onboardingExperienceSchema.parse(
          revision.configurationJson,
        );
        await validateMedia(configuration, false, tx);
        const version = expectedVersion + 1;
        const json = jsonInput(configuration);
        const saved = await tx.onboardingExperience.upsert({
          where: { id: "default" },
          create: {
            id: "default",
            draftJson: json,
            draftVersion: version,
            updatedById: editorId,
          },
          update: {
            draftJson: json,
            draftVersion: version,
            updatedById: editorId,
          },
        });
        await tx.onboardingExperienceRevision.create({
          data: {
            configurationId: "default",
            version,
            configurationJson: json,
            editorId,
            changeNote: `Restored revision ${revisionVersion}`,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: editorId,
            action: "ONBOARDING_EXPERIENCE_RESTORED",
            entity: "OnboardingExperience",
            entityId: "default",
            metadata: { fromVersion: revisionVersion, version },
          },
        });
        return saved;
      });
      res.json({
        draft: onboardingExperienceSchema.parse(restored.draftJson),
        draftVersion: restored.draftVersion,
        updatedAt: restored.updatedAt,
      });
    }),
  );

  registerOnboardingExperienceMediaRoutes(app, admin, storage, scanner);
}
