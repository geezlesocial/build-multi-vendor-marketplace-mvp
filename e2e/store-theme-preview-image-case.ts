import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { MediaScanStatus, MediaUploadStatus, Role } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { cleanupStoreThemePreviewImageFixture } from "./store-theme-preview-image-cleanup.js";

export function createStoreThemePreviewImageTest(dependencies: {
  csrf: (context: BrowserContext) => Promise<Record<string, string>>;
  login: (page: Page, email: string) => Promise<void>;
  prisma: PrismaClient;
}): (
  fixtures: { browser: Browser; page: Page },
  testInfo: TestInfo,
) => Promise<void> {
  const { csrf, login, prisma } = dependencies;
  return async ({ browser, page }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const realClamAv = process.env.E2E_REAL_CLAMAV === "true";
    const iconRoot = process.env.E2E_CONTENT_STORAGE_DIR;
    if (!iconRoot)
      throw new Error(
        "E2E_CONTENT_STORAGE_DIR is required for theme preview fixtures.",
      );
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAAB5ErkJggg==",
      "base64",
    );
    const originalSettings = await prisma.marketplaceSettings.findUnique({
      where: { id: "default" },
      select: { themeCatalogJson: true },
    });
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: "admin.local@example.test" },
      select: { id: true },
    });
    let uploadedAssetId: string | null = null;
    let invalidAssetId: string | null = null;
    let sellerContext: BrowserContext | null = null;
    let settingsChanged = false;

    try {
      await login(page, "admin.local@example.test");
      const buyerContext = await browser.newContext();
      const buyerPage = await buyerContext.newPage();
      try {
        await login(buyerPage, "buyer.local@example.test");
        const denied = await buyerPage.request.post(
          "/api/admin/store-themes/CLASSIC/preview-media/uploads",
          {
            data: {
              fileName: "not-authorized.png",
              contentType: "image/png",
              sizeBytes: imageBytes.length,
            },
            headers: await csrf(buyerContext),
          },
        );
        expect(denied.status()).toBe(403);
      } finally {
        await buyerContext.close();
      }

      const uploadHeaders = await csrf(page.context());
      const mismatchedType = await page.request.post(
        "/api/admin/store-themes/CLASSIC/preview-media/uploads",
        {
          data: {
            fileName: "mismatched.jpg",
            contentType: "image/png",
            sizeBytes: imageBytes.length,
          },
          headers: uploadHeaders,
        },
      );
      expect(mismatchedType.status()).toBe(415);
      const oversized = await page.request.post(
        "/api/admin/store-themes/CLASSIC/preview-media/uploads",
        {
          data: {
            fileName: "oversized.png",
            contentType: "image/png",
            sizeBytes: 5_000_001,
          },
          headers: uploadHeaders,
        },
      );
      expect(oversized.status()).toBe(413);

      const spoofedBytes = Buffer.from("not a PNG image");
      const spoofedReservation = await page.request.post(
        "/api/admin/store-themes/CLASSIC/preview-media/uploads",
        {
          data: {
            fileName: "spoofed.png",
            contentType: "image/png",
            sizeBytes: spoofedBytes.length,
          },
          headers: uploadHeaders,
        },
      );
      expect(spoofedReservation.status()).toBe(201);
      const spoofed = await spoofedReservation.json();
      invalidAssetId = spoofed.id;
      const spoofedUpload = await page.request.put(spoofed.upload.url, {
        data: spoofedBytes,
        headers: {
          ...(await csrf(page.context())),
          "content-type": "image/png",
        },
      });
      expect(spoofedUpload.status()).toBe(204);
      const spoofedFinalize = await page.request.post(
        `/api/admin/platform/branding-media/${encodeURIComponent(invalidAssetId!)}/finalize`,
        { data: {}, headers: await csrf(page.context()) },
      );
      expect(spoofedFinalize.status()).toBe(415);

      const publicBefore = await page.request.get("/api/store-themes/catalog");
      expect(publicBefore.ok()).toBeTruthy();
      const catalogBefore = await publicBefore.json();
      const expectedDefaults: Record<string, string> = {
        CLASSIC: "/theme-previews/classic.webp",
        EDITORIAL: "/theme-previews/editorial.webp",
        BOUTIQUE: "/theme-previews/boutique.webp",
        TECH_ELECTRONICS: "/theme-previews/tech-electronics.webp",
        GROCERIES: "/theme-previews/groceries.webp",
        ECOMMERCE_MARKETPLACE: "/theme-previews/ecommerce-marketplace.webp",
      };
      expect(catalogBefore.themes).toHaveLength(6);
      for (const theme of catalogBefore.themes) {
        expect(theme.previewImageUrl).toBe(expectedDefaults[theme.id]);
        const assetResponse = await page.request.get(theme.previewImageUrl);
        expect(
          assetResponse.ok(),
          `Missing preview for ${theme.name}`,
        ).toBeTruthy();
        expect(assetResponse.headers()["content-type"]).toContain("image/webp");
      }

      sellerContext = await browser.newContext();
      const sellerPage = await sellerContext.newPage();
      await login(sellerPage, "seller.local@example.test");
      await sellerPage.goto("/seller/themes");
      const editorialSellerCard = sellerPage
        .locator(".themeGalleryCard")
        .filter({
          has: sellerPage.getByRole("heading", {
            name: "Editorial",
            exact: true,
          }),
        });
      const editorialSellerImage =
        editorialSellerCard.locator(".themeArtwork img");
      await expect(editorialSellerImage).toHaveAttribute(
        "src",
        "/theme-previews/editorial.webp",
      );
      await sellerPage
        .getByLabel("Hero headline")
        .fill(`Unsaved seller edit ${suffix}`);
      const sellerThemeBefore = await sellerPage.request.get(
        "/api/seller/store-theme",
      );
      expect(sellerThemeBefore.ok()).toBeTruthy();
      const sellerLogoBefore = (await sellerThemeBefore.json()).draft
        .logoMediaId;

      await page.goto("/admin/platform");
      await page
        .getByRole("button", { name: "Themes & templates", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Themes & Templates Management",
          exact: true,
        }),
      ).toBeVisible();
      const editorialCard = page.locator(".themeAdminCard").filter({
        has: page.getByRole("heading", { name: "Editorial", exact: true }),
      });
      const imageInput = editorialCard.getByLabel(
        "Replace Editorial preview image",
      );
      await imageInput.setInputFiles({
        name: `e2e-editorial-${suffix}.png`,
        mimeType: "image/png",
        buffer: imageBytes,
      });
      await expect(editorialCard.locator(".themeArtwork img")).toHaveAttribute(
        "src",
        /^blob:/,
      );
      const adminSnapshot = await (
        await page.request.get("/api/admin/store-themes")
      ).json();
      const reservationResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/preview-media/uploads"),
      );
      const finalizeResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/branding-media\/[^/]+\/finalize/.test(response.url()),
      );
      if (realClamAv) settingsChanged = true;
      await editorialCard
        .getByRole("button", { name: "Upload & publish Editorial preview" })
        .click();
      const reservationResponse = await reservationResponsePromise;
      expect(reservationResponse.status()).toBe(201);
      const reservation = await reservationResponse.json();
      uploadedAssetId = reservation.id;
      expect(reservation).toMatchObject({
        scanStatus: "QUARANTINED",
        publicAfterUpload: false,
      });
      const finalizeResponse = await finalizeResponsePromise;
      expect(finalizeResponse.ok(), await finalizeResponse.text()).toBeTruthy();
      const finalized = await finalizeResponse.json();
      expect(finalized.uploadStatus).toBe("COMPLETE");

      const adminList = await (
        await page.request.get("/api/admin/store-themes")
      ).json();
      const uploaded = adminList.previewMedia.find(
        (asset: { id: string }) => asset.id === uploadedAssetId,
      );
      expect(uploaded).toBeTruthy();
      const assetRecord = await prisma.mediaAsset.findUnique({
        where: { id: uploadedAssetId! },
        select: {
          uploadStatus: true,
          scanStatus: true,
          scanAttemptCount: true,
          scanCompletedAt: true,
          scannerProvider: true,
        },
      });
      expect(assetRecord?.uploadStatus).toBe(MediaUploadStatus.COMPLETE);

      if (!realClamAv) {
        expect(finalized.scanStatus).toBe("QUARANTINED");
        expect(assetRecord?.scanStatus).toBe(MediaScanStatus.QUARANTINED);
        await expect(
          page.locator('p.notice[role="status"][aria-live="polite"]'),
        ).toContainText("safely quarantined", { timeout: 30_000 });
        await expect(
          editorialCard.getByRole("button", { name: "Retry scan" }),
        ).toBeVisible();
        expect(
          (
            await page.request.get(
              `/content-media/${encodeURIComponent(uploadedAssetId!)}`,
            )
          ).status(),
        ).toBe(404);
        await page.reload();
        const reloadedEditorialCard = page.locator(".themeAdminCard").filter({
          has: page.getByRole("heading", { name: "Editorial", exact: true }),
        });
        await expect(
          reloadedEditorialCard.getByRole("button", { name: "Retry scan" }),
        ).toBeVisible();
        await reloadedEditorialCard
          .getByRole("button", { name: "Retry scan" })
          .click();
        await expect(
          page.locator('p.notice[role="status"][aria-live="polite"]'),
        ).toContainText("remains private in quarantine");
        await expect(editorialSellerImage).toHaveAttribute(
          "src",
          "/theme-previews/editorial.webp",
        );
        await expect(sellerPage.getByLabel("Hero headline")).toHaveValue(
          `Unsaved seller edit ${suffix}`,
        );
        const unchangedSellerTheme = await sellerPage.request.get(
          "/api/seller/store-theme",
        );
        expect((await unchangedSellerTheme.json()).draft.logoMediaId).toBe(
          sellerLogoBefore,
        );
        return;
      }

      expect(finalized.scanStatus).toBe("APPROVED");
      expect(assetRecord).toMatchObject({
        uploadStatus: MediaUploadStatus.COMPLETE,
        scanStatus: MediaScanStatus.APPROVED,
        scannerProvider: "clamav",
      });
      expect(assetRecord?.scanAttemptCount).toBeGreaterThan(0);
      expect(assetRecord?.scanCompletedAt).toBeInstanceOf(Date);
      const scanAudit = await prisma.auditLog.findFirst({
        where: {
          actorId: admin.id,
          action: "MEDIA_SCAN_APPROVED",
          entityId: uploadedAssetId!,
        },
        select: { metadata: true },
      });
      expect(scanAudit?.metadata).toMatchObject({
        scanner: "clamav",
        result: "CLEAN",
      });
      await expect(
        page.locator('p.notice[role="status"][aria-live="polite"]'),
      ).toContainText(/preview updated/i, { timeout: 30_000 });
      await expect(editorialCard.locator(".themeArtwork img")).toHaveAttribute(
        "src",
        `/content-media/${uploadedAssetId}`,
      );
      const catalogAfterPublish = await (
        await page.request.get("/api/store-themes/catalog")
      ).json();
      const publishedPreview = catalogAfterPublish.themes.find(
        (theme: { id: string }) => theme.id === "EDITORIAL",
      );
      expect(publishedPreview.previewImageUrl).toBe(
        `/content-media/${uploadedAssetId}`,
      );
      const publicImage = await page.request.get(
        publishedPreview.previewImageUrl,
      );
      expect(publicImage.ok()).toBeTruthy();
      expect(publicImage.headers()["content-type"]).toContain("image/webp");
      await testInfo.attach("admin-preview-published", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });

      const publishedAdminSnapshot = await (
        await page.request.get("/api/admin/store-themes")
      ).json();
      const headers = await csrf(page.context());
      const wrongTheme = await page.request.put(
        "/api/admin/store-themes/CLASSIC/preview-image",
        {
          data: {
            assetId: uploadedAssetId,
            expectedUpdatedAt: publishedAdminSnapshot.configUpdatedAt,
            reason: "Reject cross-theme preview assignment",
          },
          headers,
        },
      );
      expect(wrongTheme.status()).toBe(400);
      const staleUpdate = await page.request.put(
        "/api/admin/store-themes/EDITORIAL/preview-image",
        {
          data: {
            assetId: uploadedAssetId,
            expectedUpdatedAt: adminSnapshot.configUpdatedAt,
            reason: "Reject stale theme preview update",
          },
          headers,
        },
      );
      expect(staleUpdate.status()).toBe(409);
      const publishAudit = await prisma.auditLog.findFirst({
        where: {
          actorId: admin.id,
          action: "STORE_THEME_CATALOG_UPDATED",
          entityId: "default",
        },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      });
      expect(publishAudit?.metadata).toMatchObject({
        preset: "EDITORIAL",
        previousAssetId: null,
        assetId: uploadedAssetId,
        change: "THEME_PREVIEW_IMAGE",
      });

      await expect(editorialSellerImage).toHaveAttribute(
        "src",
        `/content-media/${uploadedAssetId}`,
        { timeout: 25_000 },
      );
      await expect(sellerPage.getByLabel("Hero headline")).toHaveValue(
        `Unsaved seller edit ${suffix}`,
      );
      const sellerThemeAfter = await sellerPage.request.get(
        "/api/seller/store-theme",
      );
      expect((await sellerThemeAfter.json()).draft.logoMediaId).toBe(
        sellerLogoBefore,
      );
      await testInfo.attach("seller-preview-refreshed-draft-preserved", {
        body: await sellerPage.screenshot({ fullPage: true }),
        contentType: "image/png",
      });

      await page.reload();
      await page
        .getByRole("button", { name: "Themes & templates", exact: true })
        .click();
      const restoredEditorialCard = page.locator(".themeAdminCard").filter({
        has: page.getByRole("heading", { name: "Editorial", exact: true }),
      });
      await expect(
        restoredEditorialCard.locator(".themeArtwork img"),
      ).toHaveAttribute("src", `/content-media/${uploadedAssetId}`);
      page.once("dialog", (dialog) => dialog.accept());
      await restoredEditorialCard
        .getByRole("button", { name: "Restore default image" })
        .click();
      await expect(
        page.locator('p.notice[role="status"][aria-live="polite"]'),
      ).toContainText("preview updated");
      await expect(
        restoredEditorialCard.locator(".themeArtwork img"),
      ).toHaveAttribute("src", "/theme-previews/editorial.webp");
      await expect(editorialSellerImage).toHaveAttribute(
        "src",
        "/theme-previews/editorial.webp",
        { timeout: 25_000 },
      );
      const catalogAfterRestore = await (
        await page.request.get("/api/store-themes/catalog")
      ).json();
      expect(
        catalogAfterRestore.themes.find(
          (theme: { id: string }) => theme.id === "EDITORIAL",
        ).previewImageUrl,
      ).toBe("/theme-previews/editorial.webp");
      const restoreAuditEntries = await prisma.auditLog.findMany({
        where: {
          actorId: admin.id,
          action: "STORE_THEME_CATALOG_UPDATED",
          entityId: "default",
        },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { metadata: true },
      });
      expect(restoreAuditEntries[0]?.metadata).toMatchObject({
        preset: "EDITORIAL",
        previousAssetId: uploadedAssetId,
        assetId: null,
        change: "THEME_PREVIEW_IMAGE",
      });
      expect(restoreAuditEntries[1]?.metadata).toMatchObject({
        preset: "EDITORIAL",
        assetId: uploadedAssetId,
        change: "THEME_PREVIEW_IMAGE",
      });
      await expect(sellerPage.getByLabel("Hero headline")).toHaveValue(
        `Unsaved seller edit ${suffix}`,
      );
      const sellerThemeAfterRestore = await sellerPage.request.get(
        "/api/seller/store-theme",
      );
      expect((await sellerThemeAfterRestore.json()).draft.logoMediaId).toBe(
        sellerLogoBefore,
      );
      await testInfo.attach("admin-preview-default-restored", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } finally {
      await sellerContext?.close();
      await cleanupStoreThemePreviewImageFixture({
        prisma,
        originalSettings,
        settingsChanged,
        uploadedAssetId,
        invalidAssetId,
        iconRoot,
      });
    }
  };
}
