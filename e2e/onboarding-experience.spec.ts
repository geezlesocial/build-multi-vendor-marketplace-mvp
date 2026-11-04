import { Role } from "@prisma/client";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { OnboardingExperience } from "../apps/web/src/onboarding-experience.js";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";
import { expectNoHorizontalOverflow } from "./layout-assertions.js";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL must point to the disposable browser-test database.",
  );
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);
const adminEmail = "admin.local@example.test";
const password = "LocalDemoOnly-ChangeMe-123!";

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  return { "x-csrf-token": csrf! };
}

async function expectOnboardingMediaDenied(page: Page, assetId: string) {
  const headers = await csrfHeaders(page);
  const list = await page.request.get("/api/admin/platform/onboarding-media", {
    headers,
  });
  expect(list.status()).toBe(403);
  const upload = await page.request.post(
    "/api/admin/platform/onboarding-media/uploads",
    {
      data: { fileName: "blocked.png", contentType: "image/png", sizeBytes: 8 },
      headers,
    },
  );
  expect(upload.status()).toBe(403);
  const preview = await page.request.get(
    `/api/admin/platform/onboarding-media/${encodeURIComponent(assetId)}/preview`,
    { headers },
  );
  expect(preview.status()).toBe(403);
  const retry = await page.request.post(
    `/api/admin/platform/onboarding-media/${encodeURIComponent(assetId)}/scan-retry`,
    { data: {}, headers },
  );
  expect(retry.status()).toBe(403);
}

test.afterAll(async () => prisma.$disconnect());

test("admin-managed onboarding drafts stay private until publish and retain required steps", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const sellerContext = await browser.newContext();
  const sellerPage = await sellerContext.newPage();
  const adminLogin = await adminPage.request.post("/api/auth/login", {
    data: { email: adminEmail, password },
  });
  expect(adminLogin.ok(), await adminLogin.text()).toBeTruthy();
  const initialResponse = await adminPage.request.get(
    "/api/admin/onboarding/experience",
  );
  expect(initialResponse.ok(), await initialResponse.text()).toBeTruthy();
  const initial = (await initialResponse.json()) as {
    draft: {
      welcome: { title: string; heroMediaId: string | null; heroAlt: string };
      sections: { id: string }[];
    };
    published: { welcome: { title: string } } | null;
    draftVersion: number;
  };
  const originalPublic = initial.published ?? initial.draft;
  const editorHeaders = await csrfHeaders(adminPage);
  const memberEmail = `onboarding-experience-${randomUUID()}@example.test`;
  const template = await prisma.user.findUniqueOrThrow({
    where: { email: "buyer.local@example.test" },
    select: { passwordHash: true },
  });
  const member = await prisma.user.create({
    data: {
      email: memberEmail,
      name: "Experience preview member",
      role: Role.BUYER,
      passwordHash: template.passwordHash,
      emailVerifiedAt: new Date(),
      onboardingCompletedAt: null,
    },
  });
  const seller = await prisma.user.create({
    data: {
      email: `onboarding-experience-seller-${randomUUID()}@example.test`,
      name: "Experience preview seller",
      role: Role.SELLER,
      passwordHash: template.passwordHash,
      emailVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(),
    },
  });
  const quarantineId = randomUUID();
  try {
    const memberLogin = await memberPage.request.post("/api/auth/login", {
      data: { email: memberEmail, password },
    });
    expect(memberLogin.ok(), await memberLogin.text()).toBeTruthy();
    const sellerLogin = await sellerPage.request.post("/api/auth/login", {
      data: { email: seller.email, password },
    });
    expect(sellerLogin.ok(), await sellerLogin.text()).toBeTruthy();
    const incompleteMemberDenied = await memberPage.request.get(
      "/api/admin/onboarding/experience",
    );
    expect(incompleteMemberDenied.status()).toBe(428);
    await prisma.user.update({
      where: { id: member.id },
      data: { onboardingCompletedAt: new Date() },
    });
    const denied = await memberPage.request.get(
      "/api/admin/onboarding/experience",
    );
    expect(denied.status()).toBe(403);
    const sellerDenied = await sellerPage.request.get(
      "/api/admin/onboarding/experience",
    );
    expect(sellerDenied.status()).toBe(403);
    const sellerCsrf = await csrfHeaders(sellerPage);
    await expectOnboardingMediaDenied(memberPage, quarantineId);
    await expectOnboardingMediaDenied(sellerPage, quarantineId);
    for (const [method, endpoint, body] of [
      [
        "put",
        "/api/admin/onboarding/experience/draft",
        { expectedVersion: 0, configuration: initial.draft },
      ],
      [
        "post",
        "/api/admin/onboarding/experience/publish",
        { expectedVersion: 0 },
      ],
      [
        "post",
        "/api/admin/onboarding/experience/reset",
        { expectedVersion: 0 },
      ],
      [
        "post",
        "/api/admin/onboarding/experience/revisions/1/restore",
        { expectedVersion: 0 },
      ],
    ] as const) {
      const response = await sellerPage.request[method](endpoint, {
        data: body,
        headers: sellerCsrf,
      });
      expect(response.status()).toBe(403);
    }

    const unsafeUpload = await adminPage.request.post(
      "/api/admin/platform/onboarding-media/uploads",
      {
        data: {
          fileName: "unsafe.svg",
          contentType: "image/svg+xml",
          sizeBytes: 25,
        },
        headers: editorHeaders,
      },
    );
    expect(unsafeUpload.status()).toBe(415);
    const invalidDraft = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: {
          expectedVersion: initial.draftVersion,
          configuration: {
            ...initial.draft,
            sections: initial.draft.sections.slice(1),
          },
        },
        headers: editorHeaders,
      },
    );
    expect(invalidDraft.status()).toBe(400);

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
      select: { id: true },
    });
    await prisma.mediaAsset.create({
      data: {
        id: quarantineId,
        storageKey: `e2e-onboarding/${quarantineId}`,
        originalName: "pending.webp",
        safeName: "pending.webp",
        kind: "IMAGE",
        detectedMime: "image/webp",
        sizeBytes: 32,
        checksum: `pending-${quarantineId}`,
        uploaderId: admin.id,
        purpose: "ONBOARDING_EXPERIENCE",
        uploadStatus: "COMPLETE",
        storageProvider: "LOCAL",
        scanStatus: "QUARANTINED",
      },
    });
    const inaccessiblePendingImage = await memberPage.request.get(
      `/content-media/${quarantineId}`,
    );
    expect(inaccessiblePendingImage.status()).toBe(404);
    const privateImageDraft = {
      ...initial.draft,
      welcome: {
        ...initial.draft.welcome,
        heroMediaId: quarantineId,
        heroAlt: "A private pending hero",
      },
    };
    const privateImageSaved = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: {
          expectedVersion: initial.draftVersion,
          configuration: privateImageDraft,
        },
        headers: editorHeaders,
      },
    );
    expect(privateImageSaved.ok(), await privateImageSaved.text()).toBeTruthy();
    const privateVersion = (
      (await privateImageSaved.json()) as { draftVersion: number }
    ).draftVersion;
    const blockedPublish = await adminPage.request.post(
      "/api/admin/onboarding/experience/publish",
      { data: { expectedVersion: privateVersion }, headers: editorHeaders },
    );
    expect(blockedPublish.status()).toBe(409);

    const marker = `Draft ${randomUUID()}`;
    const firstDraft = {
      ...initial.draft,
      welcome: {
        ...initial.draft.welcome,
        heroMediaId: null,
        heroAlt: "",
        title: marker,
      },
    };
    const firstSave = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: { expectedVersion: privateVersion, configuration: firstDraft },
        headers: editorHeaders,
      },
    );
    expect(firstSave.ok(), await firstSave.text()).toBeTruthy();
    const firstVersion = ((await firstSave.json()) as { draftVersion: number })
      .draftVersion;
    const protectedHistoryMedia = await adminPage.request.delete(
      `/api/admin/content/media/${quarantineId}`,
      { headers: editorHeaders },
    );
    expect(protectedHistoryMedia.status()).toBe(409);
    const secondSave = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: {
          expectedVersion: firstVersion,
          configuration: {
            ...firstDraft,
            welcome: { ...firstDraft.welcome, title: `${marker} changed` },
          },
        },
        headers: editorHeaders,
      },
    );
    expect(secondSave.ok(), await secondSave.text()).toBeTruthy();
    const secondVersion = (
      (await secondSave.json()) as { draftVersion: number }
    ).draftVersion;
    const staleSave = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: { expectedVersion: firstVersion, configuration: firstDraft },
        headers: editorHeaders,
      },
    );
    expect(staleSave.status()).toBe(409);

    await prisma.user.update({
      where: { id: member.id },
      data: { onboardingCompletedAt: null },
    });
    const restored = await adminPage.request.post(
      `/api/admin/onboarding/experience/revisions/${firstVersion}/restore`,
      { data: { expectedVersion: secondVersion }, headers: editorHeaders },
    );
    expect(restored.ok(), await restored.text()).toBeTruthy();
    const restoredBody = (await restored.json()) as {
      draftVersion: number;
      draft: { welcome: { title: string } };
    };
    expect(restoredBody.draft.welcome.title).toBe(marker);
    const beforePublish = await memberPage.request.get("/api/onboarding");
    expect(beforePublish.ok(), await beforePublish.text()).toBeTruthy();
    expect(
      (
        (await beforePublish.json()) as {
          experience: { welcome: { title: string } };
        }
      ).experience.welcome.title,
    ).not.toBe(marker);

    const publish = await adminPage.request.post(
      "/api/admin/onboarding/experience/publish",
      {
        data: { expectedVersion: restoredBody.draftVersion },
        headers: editorHeaders,
      },
    );
    expect(publish.ok(), await publish.text()).toBeTruthy();
    const afterPublish = await memberPage.request.get("/api/onboarding");
    expect(afterPublish.ok(), await afterPublish.text()).toBeTruthy();
    expect(
      (
        (await afterPublish.json()) as {
          experience: {
            welcome: { title: string };
            sections: { id: string }[];
          };
        }
      ).experience,
    ).toMatchObject({
      welcome: { title: marker },
      sections: [
        { id: "ACCOUNT" },
        { id: "STORES" },
        { id: "CURRENCY" },
        { id: "REFERRAL" },
      ],
    });

    const publishedMediaRefresh = await memberPage.request.get(
      "/api/onboarding?view=experience",
    );
    expect(publishedMediaRefresh.headers()["cache-control"]).toContain(
      "no-store",
    );
    expect(
      (
        (await publishedMediaRefresh.json()) as {
          experience: { welcome: { title: string } };
        }
      ).experience.welcome.title,
    ).toBe(marker);
    const resetDraft = await adminPage.request.post(
      "/api/admin/onboarding/experience/reset",
      {
        data: { expectedVersion: restoredBody.draftVersion },
        headers: editorHeaders,
      },
    );
    expect(resetDraft.ok(), await resetDraft.text()).toBeTruthy();
    const resetBody = (await resetDraft.json()) as {
      draftVersion: number;
      draft: { welcome: { title: string } };
    };
    expect(resetBody.draft.welcome.title).toBe(initial.draft.welcome.title);
    const stillPublished = await memberPage.request.get("/api/onboarding");
    expect(
      (
        (await stillPublished.json()) as {
          experience: { welcome: { title: string } };
        }
      ).experience.welcome.title,
    ).toBe(marker);

    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.goto("/admin/platform");
    await adminPage.getByLabel("Jump to module").selectOption("onboarding");
    await expect(
      adminPage.getByRole("heading", { name: "Onboarding experience" }),
    ).toBeVisible();
    await adminPage
      .getByRole("button", { name: "Mobile", exact: true })
      .click();
    await expect(
      adminPage.getByRole("button", { name: "Mobile", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expectNoHorizontalOverflow(adminPage);
    const headingInput = adminPage.getByLabel("Welcome heading");
    await headingInput.fill("Unsaved live preview title");
    await expect(adminPage.locator(".onboardingPreviewHero h3")).toHaveText(
      "Unsaved live preview title",
    );
    await adminPage.keyboard.press("Tab");
    await expect(adminPage.locator(":focus-visible")).toBeVisible();
    await adminPage.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [320, 375, 768, 1024, 1440]) {
      await adminPage.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(adminPage);
    }
    await memberPage.goto("/onboarding");
    await expect(memberPage.getByRole("heading", { level: 1 })).toBeVisible();
    for (const width of [320, 375, 768, 1024, 1440]) {
      await memberPage.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(memberPage);
    }
    await adminPage
      .getByRole("button", { name: "Desktop", exact: true })
      .click();
    await adminPage.setViewportSize({ width: 1440, height: 1000 });
    await test.info().attach("onboarding-admin-desktop.png", {
      body: await adminPage.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await adminPage
      .getByRole("button", { name: "Mobile", exact: true })
      .click();
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await test.info().attach("onboarding-admin-mobile.png", {
      body: await adminPage.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await memberPage.setViewportSize({ width: 1440, height: 1000 });
    await test.info().attach("onboarding-member-desktop.png", {
      body: await memberPage.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await memberPage.setViewportSize({ width: 390, height: 844 });
    await test.info().attach("onboarding-member-mobile.png", {
      body: await memberPage.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    const current = await adminPage.request.get(
      "/api/admin/onboarding/experience",
    );
    if (current.ok()) {
      const latest = (await current.json()) as { draftVersion: number };
      const restoreDraft = await adminPage.request.put(
        "/api/admin/onboarding/experience/draft",
        {
          data: {
            expectedVersion: latest.draftVersion,
            configuration: originalPublic,
            reason: "Restore disposable onboarding E2E fixture",
          },
          headers: editorHeaders,
        },
      );
      if (restoreDraft.ok()) {
        const restoredVersion = (
          (await restoreDraft.json()) as { draftVersion: number }
        ).draftVersion;
        await adminPage.request.post(
          "/api/admin/onboarding/experience/publish",
          {
            data: { expectedVersion: restoredVersion },
            headers: editorHeaders,
          },
        );
      }
    }
    await prisma.mediaAsset.deleteMany({ where: { id: quarantineId } });
    await prisma.user.deleteMany({ where: { id: member.id } });
    await prisma.user.deleteMany({ where: { id: seller.id } });
    await sellerContext.close();
    await memberContext.close();
    await adminContext.close();
  }
});

test("real ClamAV onboarding upload stays private until publish and refreshes an open member page", async ({
  browser,
}) => {
  test.skip(
    process.env.E2E_REAL_CLAMAV !== "true",
    "This acceptance requires the dedicated local ClamAV integration service.",
  );
  test.setTimeout(90_000);
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const memberPage = await memberContext.newPage();
  const adminLogin = await adminPage.request.post("/api/auth/login", {
    data: { email: adminEmail, password },
  });
  expect(adminLogin.ok(), await adminLogin.text()).toBeTruthy();
  const original = await adminPage.request.get(
    "/api/admin/onboarding/experience",
  );
  expect(original.ok(), await original.text()).toBeTruthy();
  const originalState = (await original.json()) as {
    draft: OnboardingExperience;
    published: OnboardingExperience | null;
    draftVersion: number;
  };
  const buyerTemplate = await prisma.user.findUniqueOrThrow({
    where: { email: "buyer.local@example.test" },
    select: { passwordHash: true },
  });
  const member = await prisma.user.create({
    data: {
      email: `onboarding-clamav-${randomUUID()}@example.test`,
      name: "ClamAV onboarding member",
      role: Role.BUYER,
      passwordHash: buyerTemplate.passwordHash,
      emailVerifiedAt: new Date(),
      onboardingCompletedAt: null,
    },
  });
  let uploadedAssetId: string | null = null;
  const adminHeaders = await csrfHeaders(adminPage);
  try {
    const baselineSave = await adminPage.request.put(
      "/api/admin/onboarding/experience/draft",
      {
        data: {
          expectedVersion: originalState.draftVersion,
          configuration: originalState.draft,
          reason: "Create disposable ClamAV acceptance restore point",
        },
        headers: adminHeaders,
      },
    );
    expect(baselineSave.ok(), await baselineSave.text()).toBeTruthy();
    const baseline = (await baselineSave.json()) as { draftVersion: number };
    const baselinePublish = await adminPage.request.post(
      "/api/admin/onboarding/experience/publish",
      {
        data: { expectedVersion: baseline.draftVersion },
        headers: adminHeaders,
      },
    );
    expect(baselinePublish.ok(), await baselinePublish.text()).toBeTruthy();

    const memberLogin = await memberPage.request.post("/api/auth/login", {
      data: { email: member.email, password },
    });
    expect(memberLogin.ok(), await memberLogin.text()).toBeTruthy();
    await memberPage.goto("/onboarding");
    await expect(memberPage.getByRole("heading", { level: 1 })).toBeVisible();

    const priorMediaResponse = await adminPage.request.get(
      "/api/admin/platform/onboarding-media",
    );
    expect(
      priorMediaResponse.ok(),
      await priorMediaResponse.text(),
    ).toBeTruthy();
    const priorMedia = (await priorMediaResponse.json()) as { id: string }[];

    await adminPage.setViewportSize({ width: 1280, height: 900 });
    await adminPage.goto("/admin/platform");
    await adminPage
      .getByRole("button", { name: "Onboarding readiness", exact: true })
      .click();
    const pngDataUrl = await adminPage.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.fillStyle = "#315a45";
      context.fillRect(0, 0, 24, 24);
      return canvas.toDataURL("image/png");
    });
    await adminPage.getByLabel("Choose onboarding hero image").setInputFiles({
      name: "onboarding-hero-acceptance.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngDataUrl.split(",")[1] ?? "", "base64"),
    });
    await adminPage
      .getByRole("button", { name: "Upload onboarding hero image replacement" })
      .click();
    await expect(
      adminPage.locator(".brandingImageControl p[role='status']"),
    ).toContainText("Image scanned and saved as a draft", { timeout: 45_000 });

    const uploadedMediaResponse = await adminPage.request.get(
      "/api/admin/platform/onboarding-media",
    );
    const uploadedMedia = (await uploadedMediaResponse.json()) as {
      id: string;
      scanStatus: string;
      uploadStatus: string;
    }[];
    const uploadedAsset = uploadedMedia.find(
      (asset) => !priorMedia.some((previous) => previous.id === asset.id),
    );
    expect(
      uploadedAsset,
      "A new onboarding media record should be listed.",
    ).toBeTruthy();
    uploadedAssetId = uploadedAsset!.id;
    expect(uploadedAsset!.uploadStatus).toBe("COMPLETE");
    expect(uploadedAsset!.scanStatus).toBe("APPROVED");
    const privateBeforePublish = await memberPage.request.get(
      `/content-media/${uploadedAssetId}`,
    );
    expect(privateBeforePublish.status()).toBe(404);
    await expect(memberPage.locator(".onboardingHeroImage")).toHaveCount(0);

    await adminPage
      .getByLabel("Hero alternative text")
      .fill("A welcoming green marketplace graphic");
    await adminPage.getByRole("button", { name: "Save draft" }).click();
    await expect(adminPage.locator(".onboardingEditorStatus")).toContainText(
      "Draft saved",
    );
    const draftResponse = await adminPage.request.get(
      "/api/admin/onboarding/experience",
    );
    const draftState = (await draftResponse.json()) as {
      draft: OnboardingExperience;
      draftVersion: number;
    };
    expect(draftState.draft.welcome.heroMediaId).toBe(uploadedAssetId);
    const stillPrivateAfterDraftSave = await memberPage.request.get(
      `/content-media/${uploadedAssetId}`,
    );
    expect(stillPrivateAfterDraftSave.status()).toBe(404);
    const stillPrivate = await memberPage.request.get("/api/onboarding");
    expect(
      ((await stillPrivate.json()) as { experience: OnboardingExperience })
        .experience.welcome.heroMediaId,
    ).not.toBe(uploadedAssetId);

    adminPage.once("dialog", (dialog) => void dialog.accept());
    await adminPage.getByRole("button", { name: "Publish experience" }).click();
    await expect(adminPage.locator(".onboardingEditorStatus")).toContainText(
      "published",
    );
    const publicMedia = await memberPage.request.get(
      `/content-media/${uploadedAssetId}`,
    );
    expect(publicMedia.status()).toBe(200);
    const liveRefresh = memberPage.waitForResponse((response) =>
      response.url().includes("/api/onboarding?view=experience"),
    );
    await memberPage.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await liveRefresh;
    await expect(memberPage.locator(".onboardingHeroImage")).toHaveAttribute(
      "src",
      `/content-media/${uploadedAssetId}`,
    );
    await expect(memberPage.locator(".onboardingHeroImage")).toHaveAttribute(
      "alt",
      "A welcoming green marketplace graphic",
    );

    const assetAudit = await prisma.auditLog.findMany({
      where: { entity: "MediaAsset", entityId: uploadedAssetId },
      select: { action: true },
    });
    expect(assetAudit.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        "ONBOARDING_EXPERIENCE_MEDIA_UPLOAD_RESERVED",
        "ONBOARDING_EXPERIENCE_MEDIA_QUARANTINED",
        "MEDIA_SCAN_APPROVED",
      ]),
    );
    const publishAudit = await prisma.auditLog.count({
      where: {
        entity: "OnboardingExperience",
        entityId: "default",
        action: "ONBOARDING_EXPERIENCE_PUBLISHED",
      },
    });
    expect(publishAudit).toBeGreaterThan(0);

    const restore = await adminPage.request.post(
      `/api/admin/onboarding/experience/revisions/${baseline.draftVersion}/restore`,
      {
        data: { expectedVersion: draftState.draftVersion },
        headers: adminHeaders,
      },
    );
    expect(restore.ok(), await restore.text()).toBeTruthy();
    const restoredVersion = ((await restore.json()) as { draftVersion: number })
      .draftVersion;
    const republish = await adminPage.request.post(
      "/api/admin/onboarding/experience/publish",
      {
        data: { expectedVersion: restoredVersion },
        headers: adminHeaders,
      },
    );
    expect(republish.ok(), await republish.text()).toBeTruthy();
    const restoredPublic = await memberPage.request.get("/api/onboarding");
    expect(restoredPublic.ok(), await restoredPublic.text()).toBeTruthy();
    const restoredExperience = (await restoredPublic.json()) as {
      experience: OnboardingExperience;
    };
    expect(restoredExperience.experience).toMatchObject(originalState.draft);
    const restoreAudit = await prisma.auditLog.findMany({
      where: {
        entity: "OnboardingExperience",
        entityId: "default",
        action: "ONBOARDING_EXPERIENCE_RESTORED",
      },
      select: { action: true },
    });
    expect(restoreAudit.length).toBeGreaterThan(0);
    await test.info().attach("onboarding-clamav-audit-evidence.json", {
      body: Buffer.from(
        JSON.stringify(
          {
            sourceSha:
              process.env.ONBOARDING_EVIDENCE_SHA ??
              process.env.GITHUB_SHA ??
              null,
            runId: process.env.GITHUB_RUN_ID ?? null,
            uploadedAssetId,
            uploadStatus: uploadedAsset!.uploadStatus,
            scanStatus: uploadedAsset!.scanStatus,
            privateBeforePublishStatus: privateBeforePublish.status(),
            publicAfterPublishStatus: publicMedia.status(),
            mediaAuditActions: assetAudit.map((item) => item.action),
            publishAuditActions: ["ONBOARDING_EXPERIENCE_PUBLISHED"],
            restoredRevision: baseline.draftVersion,
            restoreAuditActions: restoreAudit.map((item) => item.action),
            restoredConfigurationMatchesBaseline: true,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  } finally {
    const current = await adminPage.request.get(
      "/api/admin/onboarding/experience",
    );
    if (current.ok()) {
      const latest = (await current.json()) as { draftVersion: number };
      const restoreDraft = await adminPage.request.put(
        "/api/admin/onboarding/experience/draft",
        {
          data: {
            expectedVersion: latest.draftVersion,
            configuration: originalState.published ?? originalState.draft,
            reason: "Restore disposable ClamAV onboarding fixture",
          },
          headers: adminHeaders,
        },
      );
      if (restoreDraft.ok()) {
        const savedVersion = (
          (await restoreDraft.json()) as { draftVersion: number }
        ).draftVersion;
        await adminPage.request.post(
          "/api/admin/onboarding/experience/publish",
          {
            data: { expectedVersion: savedVersion },
            headers: adminHeaders,
          },
        );
      }
    }
    await prisma.user.deleteMany({ where: { id: member.id } });
    await memberContext.close();
    await adminContext.close();
  }
});
