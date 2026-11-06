import { Prisma, type PrismaClient } from "@prisma/client";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export async function cleanupStoreThemePreviewImageFixture(args: {
  prisma: PrismaClient;
  originalSettings: { themeCatalogJson: Prisma.JsonValue | null } | null;
  settingsChanged: boolean;
  uploadedAssetId: string | null;
  invalidAssetId: string | null;
  iconRoot: string;
}): Promise<void> {
  const {
    prisma,
    originalSettings,
    settingsChanged,
    uploadedAssetId,
    invalidAssetId,
    iconRoot,
  } = args;

  if (settingsChanged && originalSettings) {
    await prisma.marketplaceSettings.update({
      where: { id: "default" },
      data: {
        themeCatalogJson:
          originalSettings.themeCatalogJson === null
            ? Prisma.DbNull
            : (originalSettings.themeCatalogJson as Prisma.InputJsonValue),
      },
    });
  } else if (settingsChanged) {
    await prisma.marketplaceSettings.deleteMany({
      where: { id: "default" },
    });
  }
  await prisma.mediaAsset.deleteMany({
    where: {
      id: {
        in: [
          ...(uploadedAssetId ? [uploadedAssetId] : []),
          ...(invalidAssetId ? [invalidAssetId] : []),
        ],
      },
    },
  });
  for (const assetId of [uploadedAssetId, invalidAssetId]) {
    if (!assetId) continue;
    rmSync(resolve(iconRoot, "platform/theme-previews", `${assetId}.webp`), {
      force: true,
    });
    rmSync(resolve(iconRoot, "platform/theme-previews", "pending", assetId), {
      force: true,
    });
  }
}
