import { expect, test, type Page } from "@playwright/test";
import {
  ContentStatus,
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaStorageProvider,
  MediaUploadStatus,
} from "@prisma/client";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const password = "LocalDemoOnly-ChangeMe-123!";
const adminEmail = "admin.local@example.test";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
if (!e2eDatabaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required; site-chrome browser tests must use the guarded disposable database.",
  );
validateE2EDatabaseURL(e2eDatabaseUrl);
const prisma = createTestPrismaClient(e2eDatabaseUrl);

test.afterAll(async () => prisma.$disconnect());

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  return { "x-csrf-token": csrf! };
}

test("admin can customize, preview, publish and serve responsive site chrome", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page, adminEmail);
  const secondTab = await page.context().newPage();
  await secondTab.goto("/");
  await expect(secondTab.locator(".topbar")).toBeVisible();
  const originalResponse = await page.request.get("/api/admin/site-chrome");
  expect(originalResponse.ok(), await originalResponse.text()).toBeTruthy();
  const originalRecord = await prisma.siteChromeConfiguration.findUnique({
    where: { id: "platform" },
  });
  expect(
    originalRecord,
    "the isolated site-chrome test requires a clean platform chrome baseline",
  ).toBeNull();
  const headerTitle = `Chrome E2E ${Date.now()}`;
  const footerTitle = `Footer E2E ${Date.now()}`;
  const iconId = randomUUID();
  const iconStorageKey = `site-chrome-e2e/${iconId}/brand-icon.gif`;
  const iconRoot = process.env.E2E_CONTENT_STORAGE_DIR;
  if (!iconRoot)
    throw new Error(
      "E2E_CONTENT_STORAGE_DIR is required for the isolated site-chrome media fixture.",
    );
  const iconPath = resolve(iconRoot, iconStorageKey);
  const ssrPageSlug = `chrome-search-${iconId.slice(0, 12)}`;
  let ssrPageId: string | null = null;
  let iconFixtureCreated = false;

  try {
    const admin = await prisma.user.findUnique({
      where: { email: adminEmail },
      select: { id: true },
    });
    expect(
      admin,
      "the local site-chrome fixture requires the seeded admin",
    ).toBeTruthy();
    const iconBytes = Buffer.from(
      "R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
      "base64",
    );
    mkdirSync(resolve(iconRoot, `site-chrome-e2e/${iconId}`), {
      recursive: true,
    });
    writeFileSync(iconPath, iconBytes, { flag: "wx" });
    await prisma.mediaAsset.create({
      data: {
        id: iconId,
        storageKey: iconStorageKey,
        originalName: "approved-e2e-brand-icon.gif",
        safeName: "approved-e2e-brand-icon.gif",
        kind: MediaKind.IMAGE,
        detectedMime: "image/gif",
        sizeBytes: iconBytes.length,
        width: 1,
        height: 1,
        checksum: createHash("sha256").update(iconBytes).digest("hex"),
        uploaderId: admin!.id,
        purpose: MediaPurpose.PLATFORM_BRANDING,
        uploadStatus: MediaUploadStatus.COMPLETE,
        storageProvider: MediaStorageProvider.LOCAL,
        scanStatus: MediaScanStatus.APPROVED,
        scanCompletedAt: new Date(),
        scannerProvider: "synthetic-e2e",
      },
    });
    iconFixtureCreated = true;
    const ssrPage = await prisma.contentPage.create({
      data: {
        slug: ssrPageSlug,
        title: "Search suggestions content page",
        bodyJson: [],
        status: ContentStatus.PUBLISHED,
        editorId: admin!.id,
        publishedAt: new Date(),
      },
    });
    ssrPageId = ssrPage.id;
    await page.goto("/admin/platform?section=chrome");
    await expect(
      page.getByRole("heading", { name: "Header & footer builder" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Header" }).click();
    await page.getByLabel("Brand title").fill(headerTitle);
    await page.getByLabel("Template").selectOption("COMMERCE");
    await page.getByLabel("Show working product/store search").check();
    await page.getByLabel("Show announcement bar").check();
    await page.getByLabel("Announcement text").fill("Chrome test announcement");
    await page.getByLabel("Announcement link (optional)").fill("/shop");
    await expect(
      page
        .getByLabel("Header logo from media library")
        .locator(`option[value="${iconId}"]`),
    ).toHaveCount(1);
    await page
      .getByLabel("Header logo from media library")
      .selectOption(iconId);
    await page.getByRole("tab", { name: "Footer" }).click();
    await page.getByLabel("Short title").fill(footerTitle);
    await page.getByLabel("Footer template").selectOption("BUSINESS");
    await page.getByLabel("Alignment").selectOption("CENTER");
    await page
      .getByLabel("Short description")
      .fill("Responsive footer generated by the isolated browser test.");
    await page.getByLabel("Logo max width (px)").fill("128");
    await page.getByLabel("Logo max height (px)").fill("56");
    await page.getByLabel("Contact email").fill("footer@example.test");
    await page.getByLabel("Contact phone").fill("+1 555 123 4567");
    await page.getByLabel("Copyright line").fill("Copyright Chrome E2E");
    await page.getByLabel("Show back-to-top button").check();
    await expect(
      page
        .getByLabel("Footer logo from media library")
        .locator(`option[value="${iconId}"]`),
    ).toHaveCount(1);
    await page
      .getByLabel("Footer logo from media library")
      .selectOption(iconId);
    await page.getByRole("button", { name: "Add link group" }).click();
    const footerGroup = page.locator(".siteChromeSectionEditor").first();
    await footerGroup.getByLabel("Section title").fill("Customer care");
    await footerGroup.getByRole("button", { name: "Add link" }).click();
    await footerGroup.getByLabel("Label").fill("Help center");
    await footerGroup.getByLabel("URL").fill("/pages/help");
    await page.getByRole("tab", { name: "Social media" }).click();
    await page.getByRole("button", { name: "Add social account" }).click();
    await expect(page.getByText("1 / 6 accounts")).toBeVisible();
    await expect(
      page.getByLabel("Choose social account 1 icon image"),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Social account 1 icon from media library")
        .locator(`option[value="${iconId}"]`),
    ).toHaveCount(1);
    await page
      .getByLabel("Social account 1 icon from media library")
      .selectOption(iconId);
    await page
      .getByLabel("Profile URL")
      .fill("https://instagram.com/marketlane");
    await page.getByLabel("Visible label").fill("Market Lane on Instagram");
    await page.getByRole("button", { name: "Add social account" }).click();
    await expect(page.getByText("2 / 6 accounts")).toBeVisible();
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(
      page.locator(".siteChromePreview .siteChromeBrand"),
    ).toContainText(headerTitle);
    await expect(
      page.locator(".siteChromePreview .siteChromeAnnouncement"),
    ).toContainText("Chrome test announcement");
    await expect(
      page.locator(
        '.siteChromePreview svg.siteChromeSocialIcon[data-platform="INSTAGRAM"]',
      ),
    ).toBeVisible();
    await page.getByLabel("Preview width").selectOption("mobile");
    await expect(page.locator(".siteChromePreview--mobile")).toBeVisible();

    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Published. Open marketplace pages refresh" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(
      page.locator(".siteChromeHeader .platformBrandName"),
    ).toHaveText(headerTitle);
    await expect(page.locator(".siteChromeLogo")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".siteChromeLogo")
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect(
      page.locator('.siteChromeHeader form[role="search"]'),
    ).toBeVisible();
    await expect(page.locator(".siteChromeAnnouncement")).toContainText(
      "Chrome test announcement",
    );
    await expect(page.locator(".siteChromeFooter")).toContainText(footerTitle);
    await expect(page.locator(".siteChromeFooter")).toContainText(
      "Responsive footer generated by the isolated browser test.",
    );
    await expect(
      page.locator('.siteChromeFooter a[href="mailto:footer@example.test"]'),
    ).toBeVisible();
    await expect(
      page.locator('.siteChromeFooter a[href="tel:+15551234567"]'),
    ).toBeVisible();
    await expect(page.locator(".siteChromeFooter")).toContainText(
      "Customer care",
    );
    await expect(
      page.locator('.siteChromeFooter a[href="/pages/help"]'),
    ).toHaveText("Help center");
    await expect(page.locator(".siteChromeFooter")).toContainText(
      "Copyright Chrome E2E",
    );
    await expect(page.locator(".marketplaceHome #featured")).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const root = document.scrollingElement;
            return root ? root.scrollHeight - window.innerHeight : 0;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    const backToTop = page.locator(".siteChromeFooterBottom button");
    await expect(backToTop).toHaveText("Back to top ↑");
    await page.evaluate(() => {
      const root = document.scrollingElement;
      if (!root || root.scrollHeight <= window.innerHeight) {
        throw new Error(
          "The public homepage must be vertically scrollable to verify its back-to-top control.",
        );
      }
      window.scrollTo({ top: root.scrollHeight, behavior: "instant" });
    });
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await backToTop.click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator(".siteChromeFooterIdentity img")).toBeVisible();
    await expect(
      page.locator(
        '.siteChromeFooter svg.siteChromeSocialIcon[data-platform="INSTAGRAM"]',
      ),
    ).toBeVisible();
    await expect(
      page.locator(".siteChromeFooter img.siteChromeSocialCustomIcon"),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".siteChromeFooter img.siteChromeSocialCustomIcon")
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    const publicStyles = await page.request.get("/api/site-chrome/public.css");
    expect(publicStyles.ok()).toBeTruthy();
    expect(await publicStyles.text()).toContain(
      "@media(min-width:381px) and (max-width:900px){.siteChromeSsrFooter--business .siteChromeSsrFooterMain{grid-template-columns:repeat(2,minmax(0,1fr))}",
    );
    await expect(page.getByRole("link", { name: /Cart/ })).toBeVisible();
    await expect(
      secondTab.locator(".siteChromeHeader .platformBrandName"),
    ).toHaveText(headerTitle);
    await expect(secondTab.locator(".siteChromeFooter")).toContainText(
      footerTitle,
    );

    await page
      .getByRole("combobox", { name: "Search products and stores" })
      .fill("Demo Canvas");
    await expect(
      page.getByRole("option", { name: /Demo Canvas Tote/ }),
    ).toBeVisible();

    await page.goto("/admin/platform?section=chrome");
    await page.getByRole("tab", { name: "Header" }).click();
    await page.getByLabel("Show working product/store search").uncheck();
    await page.getByLabel("Show announcement bar").uncheck();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Published. Open marketplace pages refresh" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(
      page.locator('.siteChromeHeader form[role="search"]'),
    ).toHaveCount(0);
    await expect(page.locator(".siteChromeAnnouncement")).toHaveCount(0);

    await page.goto("/admin/platform?section=chrome");
    await page.getByRole("tab", { name: "Header" }).click();
    await page.getByLabel("Show working product/store search").check();
    await page.getByLabel("Show announcement bar").check();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Published. Open marketplace pages refresh" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(
      page.locator('.siteChromeHeader form[role="search"]'),
    ).toBeVisible();
    await expect(page.locator(".siteChromeAnnouncement")).toContainText(
      "Chrome test announcement",
    );
    await page.goto(`/pages/${ssrPageSlug}`);
    await expect(
      page.locator('.siteChromeSsrHeader form[role="search"]'),
    ).toBeVisible();
    await expect(page.locator(".siteChromeSsrAnnouncement")).toContainText(
      "Chrome test announcement",
    );
    await page
      .getByRole("combobox", { name: "Search products and stores" })
      .fill("Demo Canvas");
    await expect(
      page.getByRole("option", { name: /Demo Canvas Tote/ }),
    ).toBeVisible();
    await expect(page.locator(".siteChromeSsrFooter")).toContainText(
      footerTitle,
    );
    await page.goto("/");

    await page.goto("/admin/platform?section=chrome");
    await page.getByRole("tab", { name: "Page visibility" }).click();
    await page.getByLabel("Suppress footer on Marketplace home").check();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Published. Open marketplace pages refresh" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(page.locator(".siteChromeFooter")).toHaveCount(0);
    await expect(page.locator(".platformLegalDisclosure")).toBeVisible();
    await expect(secondTab.locator(".siteChromeFooter")).toHaveCount(0);
    await expect(secondTab.locator(".platformLegalDisclosure")).toBeVisible();

    await page.goto("/admin/platform?section=chrome");
    await page.getByRole("tab", { name: "Page visibility" }).click();
    await page.getByLabel("Suppress footer on Marketplace home").uncheck();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Published. Open marketplace pages refresh" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(page.locator(".siteChromeFooter")).toBeVisible();
    await expect(secondTab.locator(".siteChromeFooter")).toBeVisible();
    for (const width of [320, 390, 768, 1024] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".siteChromeHeader")).toBeVisible();
      await expect(page.locator(".siteChromeFooter")).toBeVisible();
      const headerWidth = await page
        .locator(".siteChromeHeader")
        .evaluate((element) => ({
          scroll: element.scrollWidth,
          client: element.clientWidth,
        }));
      expect(
        headerWidth.scroll,
        `custom header should not overflow at ${width}px`,
      ).toBeLessThanOrEqual(headerWidth.client + 1);
      const footerWidth = await page
        .locator(".siteChromeFooter")
        .evaluate((element) => ({
          scroll: element.scrollWidth,
          client: element.clientWidth,
        }));
      expect(
        footerWidth.scroll,
        `custom footer should not overflow at ${width}px`,
      ).toBeLessThanOrEqual(footerWidth.client + 1);
    }
  } finally {
    await secondTab.close();
    await prisma.siteChromeRevision.deleteMany({
      where: { configurationId: "platform" },
    });
    await prisma.siteChromeConfiguration.deleteMany({
      where: { id: "platform" },
    });
    if (ssrPageId)
      await prisma.contentPage.deleteMany({ where: { id: ssrPageId } });
    if (iconFixtureCreated)
      await prisma.mediaAsset.deleteMany({ where: { id: iconId } });
    rmSync(iconPath, { force: true });
    rmSync(resolve(iconRoot, `site-chrome-e2e/${iconId}`), {
      recursive: true,
      force: true,
    });
  }
});
