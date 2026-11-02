import { expect, test, type Page } from "@playwright/test";
import {
  ContentStatus,
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaStorageProvider,
  MediaUploadStatus,
  Role,
  SellerStatus,
} from "@prisma/client";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";
import type { SiteChromeConfiguration } from "../apps/web/src/site-chrome-types.js";

const password = "LocalDemoOnly-ChangeMe-123!";
const adminEmail = "admin.local@example.test";
const sellerEmail = "seller.local@example.test";
const apiOrigin = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4000"}`;
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

async function setColor(page: Page, label: string, color: string) {
  await page.getByLabel(label).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, color);
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

test("legacy/free seller can view the builder but cannot save or publish premium chrome", async ({
  page,
}) => {
  await login(page, sellerEmail);
  await page.goto("/seller/site-chrome");
  await expect(
    page.getByRole("heading", { name: "Header & footer builder" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A paid Store Plan is required to publish custom site chrome.",
    ),
  ).toBeVisible();
  const response = await page.request.get("/api/seller/site-chrome");
  expect(response.ok(), await response.text()).toBeTruthy();
  const state = (await response.json()) as {
    eligible: boolean;
    draft: unknown;
    draftVersion: number;
  };
  expect(state.eligible).toBe(false);
  const save = await page.request.put("/api/seller/site-chrome", {
    data: {
      expectedVersion: state.draftVersion,
      configuration: state.draft,
      reason: "Verify free-plan restriction",
    },
    headers: await csrfHeaders(page),
  });
  expect(save.status()).toBe(403);
  const publish = await page.request.post("/api/seller/site-chrome/publish", {
    data: { expectedVersion: state.draftVersion },
    headers: await csrfHeaders(page),
  });
  expect(publish.status()).toBe(403);
});

test("custom brand colors show WCAG AA contrast warnings before publication", async ({
  page,
}) => {
  await login(page, adminEmail);
  await page.goto("/admin/platform?section=chrome");
  await page.getByRole("tab", { name: "Header" }).click();
  await setColor(page, "Background color", "#ffffff");
  await setColor(page, "Text color", "#ffffff");
  await expect(
    page.locator(".siteChromeContrastWarning").first(),
  ).toContainText("WCAG AA");
  await page.getByRole("tab", { name: "Footer" }).click();
  await setColor(page, "Text color", "#edf3ed");
  await expect(
    page.locator(".siteChromeContrastWarning").first(),
  ).toContainText("Footer text / background");
});

test("paid seller chrome is tenant-scoped, entitlement-gated, revision-safe, and stable across content slug changes", async ({
  page,
  browser,
}) => {
  const owner = await prisma.user.findUnique({
    where: { email: sellerEmail },
    include: { seller: { include: { store: true } } },
  });
  expect(owner?.seller?.status).toBe(SellerStatus.APPROVED);
  expect(owner?.seller?.store).toBeTruthy();
  const store = owner!.seller!.store!;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const start = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const configId = `store:${store.id}`;
  const originalConfiguration = await prisma.siteChromeConfiguration.findUnique(
    { where: { id: configId } },
  );
  expect(
    originalConfiguration,
    "the disposable Store fixture must not contain prior chrome data",
  ).toBeNull();
  let assignmentId = "";
  let subscriptionId = "";
  let pageId = "";
  let postId = "";
  let secondUserId = "";
  let secondSellerId = "";
  let secondStoreId = "";
  let foreignMediaId = "";
  let quarantineMediaId = "";
  let staffUserId = "";
  let staffPage: Page | null = null;
  let secondPage: Page | null = null;
  let customDomainId = "";
  let replacedAssignmentIds: string[] = [];

  try {
    // The seeded seller may already have an ACTIVE legacy-plan assignment.
    // Preserve it, temporarily supersede it, and restore it after this fixture.
    const existingAssignments = await prisma.storePlanAssignment.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { id: true },
    });
    replacedAssignmentIds = existingAssignments.map(
      (assignment) => assignment.id,
    );
    if (replacedAssignmentIds.length)
      await prisma.storePlanAssignment.updateMany({
        where: { id: { in: replacedAssignmentIds } },
        data: { status: "SUPERSEDED" },
      });

    const plan = await prisma.storePlan.create({
      data: {
        key: `chrome-e2e-${suffix}`,
        name: `Chrome E2E ${suffix}`,
        status: "ACTIVE",
        versions: {
          create: {
            version: 1,
            status: "ACTIVE",
            name: `Chrome E2E ${suffix}`,
            monthlyPriceMinor: 1200,
            annualPriceMinor: 12000,
            productLimit: 25,
            storeLimit: 1,
            vendorLimit: 1,
            staffSeatLimit: 2,
            effectiveFrom: start,
            activatedAt: start,
          },
        },
      },
      include: { versions: true },
    });
    const planVersionId = plan.versions[0]!.id;
    const assignment = await prisma.storePlanAssignment.create({
      data: {
        storeId: store.id,
        planVersionId,
        status: "ACTIVE",
        source: "SUBSCRIPTION",
        effectiveFrom: start,
        reason: "Synthetic isolated site chrome entitlement fixture",
      },
    });
    assignmentId = assignment.id;
    const subscription = await prisma.storeSubscription.create({
      data: {
        storeId: store.id,
        planVersionId,
        provider: "STRIPE",
        providerSubscriptionId: `sub_chrome_e2e_${suffix}`,
        status: "ACTIVE",
        interval: "MONTHLY",
        currency: "USD",
        monthlyPriceMinor: 1200,
        annualPriceMinor: 12000,
        freeTrialDays: 0,
        expirationBehavior: "DOWNGRADE_TO_LEGACY",
        cancellationPolicy: "CANCEL_ANYTIME",
        termsSnapshot: { fixture: "synthetic-e2e-only" },
        currentPeriodStart: start,
        currentPeriodEnd: future,
      },
    });
    subscriptionId = subscription.id;

    const secondUser = await prisma.user.create({
      data: {
        email: `chrome-isolation-${suffix}@example.test`,
        name: `Other Seller ${suffix}`,
        role: Role.SELLER,
        passwordHash: owner!.passwordHash,
        onboardingCompletedAt: new Date(),
        seller: {
          create: {
            status: SellerStatus.APPROVED,
            store: {
              create: {
                name: `Other Store ${suffix}`,
                slug: `other-chrome-${suffix}`,
              },
            },
          },
        },
      },
      include: { seller: { include: { store: true } } },
    });
    secondUserId = secondUser.id;
    secondSellerId = secondUser.seller!.id;
    secondStoreId = secondUser.seller!.store!.id;

    const pageSlug = `chrome-page-${suffix}`;
    const postSlug = `chrome-post-${suffix}`;
    const [contentPage, blogPost] = await Promise.all([
      prisma.contentPage.create({
        data: {
          storeId: store.id,
          slug: pageSlug,
          title: "Chrome suppression page",
          bodyJson: [],
          status: ContentStatus.PUBLISHED,
          editorId: owner!.id,
          publishedAt: new Date(),
        },
      }),
      prisma.blogPost.create({
        data: {
          storeId: store.id,
          slug: postSlug,
          title: "Chrome suppression post",
          bodyJson: [],
          status: ContentStatus.PUBLISHED,
          authorId: owner!.id,
          editorId: owner!.id,
          publishedAt: new Date(),
        },
      }),
    ]);
    pageId = contentPage.id;
    postId = blogPost.id;

    const otherStore = secondUser.seller!.store!;
    const [foreignMedia, quarantineMedia] = await Promise.all([
      prisma.mediaAsset.create({
        data: {
          storageKey: `chrome-e2e/${suffix}/foreign.png`,
          originalName: "foreign.png",
          safeName: "foreign.png",
          kind: MediaKind.IMAGE,
          detectedMime: "image/png",
          sizeBytes: 128,
          checksum: "a".repeat(64),
          uploaderId: secondUser.id,
          storeId: otherStore.id,
          uploadStatus: MediaUploadStatus.COMPLETE,
          scanStatus: MediaScanStatus.APPROVED,
        },
      }),
      prisma.mediaAsset.create({
        data: {
          storageKey: `chrome-e2e/${suffix}/quarantine.png`,
          originalName: "quarantine.png",
          safeName: "quarantine.png",
          kind: MediaKind.IMAGE,
          detectedMime: "image/png",
          sizeBytes: 128,
          checksum: "b".repeat(64),
          uploaderId: owner!.id,
          storeId: store.id,
          uploadStatus: MediaUploadStatus.COMPLETE,
          scanStatus: MediaScanStatus.QUARANTINED,
        },
      }),
    ]);
    foreignMediaId = foreignMedia.id;
    quarantineMediaId = quarantineMedia.id;

    const domainName = `chrome-${suffix}.example.org`;
    const domain = await prisma.storeCustomDomain.create({
      data: {
        storeId: store.id,
        domain: domainName,
        verificationTokenHash: "c".repeat(64),
        cnameTarget: "marketplace.example.test",
        status: "DNS_VERIFIED",
        verifiedAt: new Date(),
      },
    });
    customDomainId = domain.id;

    await login(page, sellerEmail);
    const initial = await page.request.get("/api/seller/site-chrome");
    expect(initial.ok(), await initial.text()).toBeTruthy();
    const initialState = (await initial.json()) as {
      eligible: boolean;
      draft: SiteChromeConfiguration;
      draftVersion: number;
    };
    expect(initialState.eligible).toBe(true);
    const firstConfiguration = structuredClone(initialState.draft);
    firstConfiguration.header.title = `Paid Store ${suffix}`;
    firstConfiguration.header.showSearch = true;
    firstConfiguration.footer.title = `Paid Footer ${suffix}`;
    firstConfiguration.suppressedPageKeys = [
      "STORE_HOME",
      `STORE_PAGE:${contentPage.id}`,
      `STORE_POST:${blogPost.id}`,
    ];

    const saveFirst = await page.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: initialState.draftVersion,
        configuration: firstConfiguration,
        reason: "Synthetic paid seller acceptance",
      },
      headers: await csrfHeaders(page),
    });
    expect(saveFirst.status(), await saveFirst.text()).toBe(200);
    const firstVersion = ((await saveFirst.json()) as { draftVersion: number })
      .draftVersion;
    const publicBeforePublish = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=HOME`,
    );
    expect(
      publicBeforePublish.ok(),
      await publicBeforePublish.text(),
    ).toBeTruthy();
    expect(
      (
        (await publicBeforePublish.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration,
    ).toBeNull();

    const staleSave = await page.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: initialState.draftVersion,
        configuration: firstConfiguration,
      },
      headers: await csrfHeaders(page),
    });
    expect(staleSave.status()).toBe(409);
    const foreignLogo = structuredClone(firstConfiguration);
    foreignLogo.header.logoMediaId = foreignMedia.id;
    const foreignLogoSave = await page.request.put("/api/seller/site-chrome", {
      data: { expectedVersion: firstVersion, configuration: foreignLogo },
      headers: await csrfHeaders(page),
    });
    expect(foreignLogoSave.status()).toBe(400);
    const foreignSocialIcon = structuredClone(firstConfiguration);
    foreignSocialIcon.footer.socials = [
      {
        id: "foreign-icon",
        platform: "INSTAGRAM",
        url: "https://instagram.com/foreign",
        label: "Foreign icon",
        iconMediaId: foreignMedia.id,
        enabled: true,
        display: "ICON_AND_LABEL",
      },
    ];
    const foreignSocialSave = await page.request.put(
      "/api/seller/site-chrome",
      {
        data: {
          expectedVersion: firstVersion,
          configuration: foreignSocialIcon,
        },
        headers: await csrfHeaders(page),
      },
    );
    expect(foreignSocialSave.status()).toBe(400);
    const quarantinedSocialIcon = structuredClone(firstConfiguration);
    quarantinedSocialIcon.footer.socials = [
      {
        id: "pending-icon",
        platform: "INSTAGRAM",
        url: "https://instagram.com/pending",
        label: "Pending icon",
        iconMediaId: quarantineMedia.id,
        enabled: true,
        display: "ICON_AND_LABEL",
      },
    ];
    const quarantinedSave = await page.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: firstVersion,
        configuration: quarantinedSocialIcon,
      },
      headers: await csrfHeaders(page),
    });
    expect(quarantinedSave.status(), await quarantinedSave.text()).toBe(200);
    const quarantinedVersion = (
      (await quarantinedSave.json()) as { draftVersion: number }
    ).draftVersion;
    const unscannedPublish = await page.request.post(
      "/api/seller/site-chrome/publish",
      {
        data: { expectedVersion: quarantinedVersion },
        headers: await csrfHeaders(page),
      },
    );
    expect(unscannedPublish.status()).toBe(409);

    const cleanSave = await page.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: quarantinedVersion,
        configuration: firstConfiguration,
      },
      headers: await csrfHeaders(page),
    });
    expect(cleanSave.status(), await cleanSave.text()).toBe(200);
    const cleanVersion = ((await cleanSave.json()) as { draftVersion: number })
      .draftVersion;
    const alternateConfiguration = structuredClone(firstConfiguration);
    alternateConfiguration.header.title = `Unpublished draft ${suffix}`;
    const alternateSave = await page.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: cleanVersion,
        configuration: alternateConfiguration,
      },
      headers: await csrfHeaders(page),
    });
    expect(alternateSave.status(), await alternateSave.text()).toBe(200);
    const alternateVersion = (
      (await alternateSave.json()) as { draftVersion: number }
    ).draftVersion;
    const restore = await page.request.post(
      `/api/seller/site-chrome/revisions/${cleanVersion}/restore`,
      {
        data: {
          expectedVersion: alternateVersion,
          reason: "Restore the reviewed page-specific draft",
        },
        headers: await csrfHeaders(page),
      },
    );
    expect(restore.status(), await restore.text()).toBe(200);
    const restoredVersion = ((await restore.json()) as { draftVersion: number })
      .draftVersion;
    const beforePublish = await page.request.get("/api/seller/site-chrome");
    expect(
      ((await beforePublish.json()) as { draft: SiteChromeConfiguration }).draft
        .header.title,
    ).toBe(firstConfiguration.header.title);
    const publish = await page.request.post("/api/seller/site-chrome/publish", {
      data: { expectedVersion: restoredVersion },
      headers: await csrfHeaders(page),
    });
    expect(publish.status(), await publish.text()).toBe(200);

    const published = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=HOME`,
    );
    const publishedState = (await published.json()) as {
      scope: string;
      configuration: SiteChromeConfiguration | null;
      footerSuppressed: boolean;
      brand: { title: string };
    };
    expect(publishedState).toMatchObject({
      scope: "STORE",
      footerSuppressed: true,
      brand: { title: store.name },
    });
    expect(publishedState.configuration?.header.title).toBe(
      firstConfiguration.header.title,
    );
    const globalHome = await page.request.get(
      "/api/site-chrome/public?kind=HOME",
    );
    const globalHomeState = (await globalHome.json()) as {
      scope: string;
      configuration: SiteChromeConfiguration | null;
      brand: { title: string };
    };
    expect(globalHomeState.scope).toBe("PLATFORM");
    expect(globalHomeState.configuration).toBeNull();
    const defaultPlatformBrand = globalHomeState.brand.title;
    expect(defaultPlatformBrand).toBeTruthy();
    const otherStoreHome = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(otherStore.slug)}&kind=HOME`,
    );
    expect(
      (
        (await otherStoreHome.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration,
    ).toBeNull();
    const product = await prisma.product.findUnique({
      where: { slug: "demo-canvas-tote" },
      select: { id: true },
    });
    expect(product).toBeTruthy();
    const productChrome = await page.request.get(
      `/api/site-chrome/public?kind=PRODUCT&slug=${encodeURIComponent(product!.id)}`,
    );
    expect(
      (
        (await productChrome.json()) as {
          configuration: SiteChromeConfiguration | null;
          scope: string;
        }
      ).scope,
    ).toBe("STORE");
    expect(
      (
        (await productChrome.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration?.header.title,
    ).toBe(firstConfiguration.header.title);

    await page.goto(`/store/${store.slug}`);
    await expect(
      page.locator(".siteChromeHeader .platformBrandName"),
    ).toHaveText(firstConfiguration.header.title);
    await expect(page.locator(".siteChromeFooter")).toHaveCount(0);
    await expect(page.locator(".platformLegalDisclosure")).toBeVisible();

    const oldPagePath = `/store/${store.slug}/pages/${contentPage.slug}`;
    const oldPageResponse = await page.request.get(
      `${apiOrigin}${oldPagePath}`,
    );
    expect(oldPageResponse.status()).toBe(200);
    const oldPageHtml = await oldPageResponse.text();
    expect(oldPageHtml).toContain(firstConfiguration.header.title);
    expect(oldPageHtml).not.toContain('<footer class="siteChromeSsrFooter');
    const oldPostResponse = await page.request.get(
      `${apiOrigin}/store/${store.slug}/blog/${blogPost.slug}`,
    );
    expect(oldPostResponse.status()).toBe(200);
    expect(await oldPostResponse.text()).not.toContain(
      '<footer class="siteChromeSsrFooter',
    );

    const renamedPageSlug = `renamed-${pageSlug}`;
    await prisma.contentPage.update({
      where: { id: contentPage.id },
      data: { slug: renamedPageSlug },
    });
    const renamedPageResponse = await page.request.get(
      `${apiOrigin}/store/${store.slug}/pages/${renamedPageSlug}`,
    );
    expect(renamedPageResponse.status()).toBe(200);
    expect(await renamedPageResponse.text()).not.toContain(
      '<footer class="siteChromeSsrFooter',
    );
    const renamedPageVisibility = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=PAGE&slug=${encodeURIComponent(renamedPageSlug)}`,
    );
    expect(
      ((await renamedPageVisibility.json()) as { footerSuppressed: boolean })
        .footerSuppressed,
    ).toBe(true);

    const mappedDomain = await page.request.get(
      `${apiOrigin}/api/public/store-domain`,
      { headers: { host: domainName } },
    );
    expect(mappedDomain.status(), await mappedDomain.text()).toBe(200);
    const mappedDomainState = (await mappedDomain.json()) as {
      storeSlug: string;
      storeName: string;
    };
    expect(mappedDomainState).toMatchObject({
      storeSlug: store.slug,
      storeName: store.name,
    });
    const mappedChrome = await page.request.get(
      `${apiOrigin}/api/site-chrome/public?storeSlug=${encodeURIComponent(mappedDomainState.storeSlug)}&kind=HOME`,
    );
    expect(
      (
        (await mappedChrome.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration?.header.title,
    ).toBe(firstConfiguration.header.title);

    const noSuppression = structuredClone(firstConfiguration);
    noSuppression.suppressedPageKeys = [];
    const unsuppressSave = await page.request.put("/api/seller/site-chrome", {
      data: { expectedVersion: restoredVersion, configuration: noSuppression },
      headers: await csrfHeaders(page),
    });
    expect(unsuppressSave.status(), await unsuppressSave.text()).toBe(200);
    const unsuppressVersion = (
      (await unsuppressSave.json()) as { draftVersion: number }
    ).draftVersion;
    const unsuppressPublish = await page.request.post(
      "/api/seller/site-chrome/publish",
      {
        data: { expectedVersion: unsuppressVersion },
        headers: await csrfHeaders(page),
      },
    );
    expect(unsuppressPublish.status(), await unsuppressPublish.text()).toBe(
      200,
    );
    const shownPageResponse = await page.request.get(
      `${apiOrigin}/store/${store.slug}/pages/${renamedPageSlug}`,
    );
    const shownPageHtml = await shownPageResponse.text();
    expect(shownPageHtml).toContain(firstConfiguration.header.title);
    expect(shownPageHtml).toContain('<footer class="siteChromeSsrFooter');
    const shownPostResponse = await page.request.get(
      `${apiOrigin}/store/${store.slug}/blog/${blogPost.slug}`,
    );
    const shownPostHtml = await shownPostResponse.text();
    expect(shownPostHtml).toContain(firstConfiguration.header.title);
    expect(shownPostHtml).toContain('<footer class="siteChromeSsrFooter');
    await page.goto(`/store/${store.slug}`);
    await expect(
      page.locator(".siteChromeHeader .platformBrandName"),
    ).toHaveText(firstConfiguration.header.title);
    await expect(page.locator(".siteChromeFooter")).toBeVisible();

    for (const status of [
      "PENDING",
      "TRIALING",
      "PAST_DUE",
      "EXPIRED",
      "CANCELLED",
      "UNPAID",
    ] as const) {
      await prisma.storeSubscription.update({
        where: { id: subscription.id },
        data: { status },
      });
      const deniedSave = await page.request.put("/api/seller/site-chrome", {
        data: {
          expectedVersion: unsuppressVersion,
          configuration: noSuppression,
        },
        headers: await csrfHeaders(page),
      });
      expect(
        deniedSave.status(),
        `draft save must be denied for ${status}`,
      ).toBe(403);
      const deniedPublish = await page.request.post(
        "/api/seller/site-chrome/publish",
        {
          data: { expectedVersion: unsuppressVersion },
          headers: await csrfHeaders(page),
        },
      );
      expect(
        deniedPublish.status(),
        `publish must be denied for ${status}`,
      ).toBe(403);
      const hidden = await page.request.get(
        `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=HOME`,
      );
      expect(
        (
          (await hidden.json()) as {
            configuration: SiteChromeConfiguration | null;
          }
        ).configuration,
        `premium chrome must be hidden for ${status}`,
      ).toBeNull();
      expect(
        (
          await prisma.siteChromeConfiguration.findUnique({
            where: { id: configId },
          })
        )?.publishedJson,
      ).toBeTruthy();
    }
    await prisma.storeSubscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", currentPeriodEnd: new Date(Date.now() - 1000) },
    });
    const elapsedPeriodState = await page.request.get(
      "/api/seller/site-chrome",
    );
    expect(elapsedPeriodState.status()).toBe(200);
    expect(
      ((await elapsedPeriodState.json()) as { eligible: boolean }).eligible,
    ).toBe(false);
    await prisma.storeSubscription.update({
      where: { id: subscription.id },
      data: { currentPeriodEnd: future },
    });
    await prisma.storePlanAssignment.update({
      where: { id: assignment.id },
      data: { status: "SUPERSEDED" },
    });
    const downgraded = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=HOME`,
    );
    expect(
      (
        (await downgraded.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration,
    ).toBeNull();
    expect(
      (
        await prisma.siteChromeConfiguration.findUnique({
          where: { id: configId },
        })
      )?.publishedJson,
    ).toBeTruthy();
    await prisma.storePlanAssignment.update({
      where: { id: assignment.id },
      data: { status: "ACTIVE" },
    });
    const reactivated = await page.request.get(
      `/api/site-chrome/public?storeSlug=${encodeURIComponent(store.slug)}&kind=HOME`,
    );
    expect(
      (
        (await reactivated.json()) as {
          configuration: SiteChromeConfiguration | null;
        }
      ).configuration?.header.title,
    ).toBe(firstConfiguration.header.title);

    const staff = await prisma.user.create({
      data: {
        email: `chrome-staff-${suffix}@example.test`,
        name: `Unauthorized Store Staff ${suffix}`,
        role: Role.CASHIER,
        passwordHash: owner!.passwordHash,
        onboardingCompletedAt: new Date(),
        staffMemberships: {
          create: {
            sellerId: owner!.seller!.id,
            canManageStoreBranding: false,
          },
        },
      },
    });
    staffUserId = staff.id;
    staffPage = await browser.newPage();
    await login(staffPage, staff.email);
    expect(
      (await staffPage.request.get("/api/seller/site-chrome")).status(),
    ).toBe(403);
    const staffSave = await staffPage.request.put("/api/seller/site-chrome", {
      data: {
        expectedVersion: unsuppressVersion,
        configuration: noSuppression,
      },
      headers: await csrfHeaders(staffPage),
    });
    expect(staffSave.status()).toBe(403);
    const staffPublish = await staffPage.request.post(
      "/api/seller/site-chrome/publish",
      {
        data: { expectedVersion: unsuppressVersion },
        headers: await csrfHeaders(staffPage),
      },
    );
    expect(staffPublish.status()).toBe(403);

    secondPage = await browser.newPage();
    await login(secondPage, secondUser.email);
    const secondStateResponse = await secondPage.request.get(
      "/api/seller/site-chrome",
    );
    expect(secondStateResponse.ok()).toBeTruthy();
    expect(
      ((await secondStateResponse.json()) as { eligible: boolean }).eligible,
    ).toBe(false);
    const secondAttempt = await secondPage.request.put(
      "/api/seller/site-chrome",
      {
        data: { expectedVersion: 0, configuration: firstConfiguration },
        headers: await csrfHeaders(secondPage),
      },
    );
    expect(secondAttempt.status()).toBe(403);
    await secondPage.goto("/");
    await expect(secondPage.locator(".topbar .platformBrandName")).toHaveText(
      defaultPlatformBrand,
    );
    await secondPage.goto(`/store/${otherStore.slug}`);
    await expect(secondPage.locator(".siteChromeHeader")).toHaveCount(0);
    await expect(secondPage.locator(".topbar .platformBrandName")).toHaveText(
      defaultPlatformBrand!,
    );

    await page.goto("/");
    await expect(page.locator(".siteChromeHeader")).toHaveCount(0);
    await expect(page.locator(".topbar .platformBrandName")).toHaveText(
      defaultPlatformBrand!,
    );
  } finally {
    await staffPage?.close();
    await secondPage?.close();
    if (customDomainId)
      await prisma.storeCustomDomain.deleteMany({
        where: { id: customDomainId },
      });
    await prisma.siteChromeRevision.deleteMany({
      where: { configurationId: configId },
    });
    await prisma.siteChromeConfiguration.deleteMany({
      where: { id: configId },
    });
    if (postId) await prisma.blogPost.deleteMany({ where: { id: postId } });
    if (pageId) await prisma.contentPage.deleteMany({ where: { id: pageId } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: { in: [foreignMediaId, quarantineMediaId].filter(Boolean) },
      },
    });
    if (subscriptionId)
      await prisma.storeSubscription.deleteMany({
        where: { id: subscriptionId },
      });
    if (assignmentId)
      await prisma.storePlanAssignment.deleteMany({
        where: { id: assignmentId },
      });
    if (replacedAssignmentIds.length)
      await prisma.storePlanAssignment.updateMany({
        where: { id: { in: replacedAssignmentIds } },
        data: { status: "ACTIVE" },
      });
    // Activated plan versions are immutable audit records. Keep this synthetic
    // version and its parent plan in the disposable E2E database; that database
    // is discarded after the browser run. Remove only the subscription and
    // assignment above so no entitlement is left attached to the seeded seller.
    if (staffUserId) {
      await prisma.sellerStaff.deleteMany({ where: { userId: staffUserId } });
      await prisma.user.deleteMany({ where: { id: staffUserId } });
    }
    if (secondStoreId)
      await prisma.store.deleteMany({ where: { id: secondStoreId } });
    if (secondSellerId)
      await prisma.seller.deleteMany({ where: { id: secondSellerId } });
    if (secondUserId)
      await prisma.user.deleteMany({ where: { id: secondUserId } });
  }
});

const captureDirectory = process.env.SITE_CHROME_CAPTURE_DIR;
if (captureDirectory)
  test("captures all six site chrome templates at desktop and mobile widths", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const output = resolve(captureDirectory);
    mkdirSync(output, { recursive: true });
    await login(page, adminEmail);
    const originalRecord = await prisma.siteChromeConfiguration.findUnique({
      where: { id: "platform" },
    });
    expect(
      originalRecord,
      "screenshot capture requires a clean disposable platform chrome baseline",
    ).toBeNull();
    const baselineResponse = await page.request.get("/api/admin/site-chrome");
    expect(baselineResponse.ok(), await baselineResponse.text()).toBeTruthy();
    const baseline = (
      (await baselineResponse.json()) as { draft: SiteChromeConfiguration }
    ).draft;
    const configuration: SiteChromeConfiguration = structuredClone(baseline);
    configuration.header.title = "Market Lane";
    configuration.header.tagline = "Independent marketplace";
    configuration.header.showSearch = true;
    configuration.footer.title = "Market Lane";
    configuration.footer.description =
      "A thoughtful marketplace for independent stores and the people who love them.";
    configuration.footer.sections = [
      {
        id: "explore",
        title: "Explore",
        links: [
          {
            id: "browse",
            label: "Browse the marketplace",
            href: "/",
            enabled: true,
          },
        ],
      },
    ];
    configuration.footer.socials = [
      {
        id: "instagram",
        platform: "INSTAGRAM",
        url: "https://instagram.com/marketlane",
        label: "Instagram",
        iconMediaId: null,
        enabled: true,
        display: "ICON_AND_LABEL",
      },
    ];

    try {
      // The admin publish flow is covered above; this opt-in visual pass seeds only the guarded disposable DB.
      const setPublishedConfiguration = async () => {
        await prisma.siteChromeConfiguration.upsert({
          where: { id: "platform" },
          create: {
            id: "platform",
            storeId: null,
            draftJson: configuration,
            publishedJson: configuration,
            draftVersion: 1,
            publishedVersion: 1,
            publishedAt: new Date(),
          },
          update: {
            draftJson: configuration,
            publishedJson: configuration,
            draftVersion: 1,
            publishedVersion: 1,
            publishedAt: new Date(),
          },
        });
        const response = await page.request.get(
          "/api/site-chrome/public?kind=HOME",
        );
        expect(response.ok(), await response.text()).toBeTruthy();
        const publicState = (await response.json()) as {
          configuration: SiteChromeConfiguration | null;
        };
        expect(publicState.configuration?.header.template).toBe(
          configuration.header.template,
        );
        expect(publicState.configuration?.footer.template).toBe(
          configuration.footer.template,
        );
      };
      const capturePublicChrome = async (
        kind: "header" | "footer",
        name: string,
        template: string,
      ) => {
        for (const [width, height, label] of [
          [1440, 1000, "desktop"],
          [390, 844, "mobile"],
        ] as const) {
          await page.setViewportSize({ width, height });
          await page.goto("/");
          const target = page.locator(
            kind === "header" ? ".siteChromeHeader" : ".siteChromeFooter",
          );
          await expect(target).toHaveClass(
            new RegExp(
              `siteChrome${kind === "header" ? "Header" : "Footer"}--${template.toLowerCase()}`,
            ),
          );
          await expect(target).toBeVisible();
          if (kind === "footer")
            await expect(target).toContainText(
              "A thoughtful marketplace for independent stores",
            );
          await target.scrollIntoViewIfNeeded();
          await target.screenshot({
            path: join(output, `${kind}-${name}-${label}.png`),
            animations: "disabled",
          });
        }
      };

      for (const [id, name] of [
        ["CLASSIC", "classic-marketplace"],
        ["EDITORIAL", "editorial-premium"],
        ["COMMERCE", "commerce-pro"],
      ] as const) {
        configuration.header.template = id;
        await setPublishedConfiguration();
        await capturePublicChrome("header", name, id);
      }
      for (const [id, name] of [
        ["MINIMAL", "minimal-classic"],
        ["BUSINESS", "business-columns"],
        ["SIGNATURE", "signature-brand"],
      ] as const) {
        configuration.footer.template = id;
        await setPublishedConfiguration();
        await capturePublicChrome("footer", name, id);
      }
    } finally {
      await prisma.siteChromeRevision.deleteMany({
        where: { configurationId: "platform" },
      });
      await prisma.siteChromeConfiguration.deleteMany({
        where: { id: "platform" },
      });
    }
  });
