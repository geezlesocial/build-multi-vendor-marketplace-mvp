import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  MediaKind,
  MediaPurpose,
  MediaScanStatus,
  MediaUploadStatus,
  MobileStorefrontTemplate,
  ProductStatus,
  Role,
  SellerStatus,
  StorePlanAssignmentSource,
  StorePlanAssignmentStatus,
  StorePlanBillingInterval,
  StorePlanStatus,
  StorePlanVersionStatus,
  StoreSubscriptionProvider,
  StoreSubscriptionStatus,
  StoreThemePreset,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required; storefront theme tests use the guarded disposable database.",
  );
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);
const password = "LocalDemoOnly-ChangeMe-123!";

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(
    response.ok(),
    `Synthetic fixture login failed with ${response.status()}.`,
  ).toBeTruthy();
}

async function csrf(context: BrowserContext) {
  const value = (await context.cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(value).toBeTruthy();
  return { "x-csrf-token": value! };
}

async function openAccount(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email);
  return { context, page };
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("paid storefront themes are tenant-scoped, revisioned, and fall back safely across subscription changes", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const [sellerTemplate, buyerTemplate] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { email: "seller.local@example.test" },
      select: { passwordHash: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { email: "buyer.local@example.test" },
      select: { passwordHash: true },
    }),
  ]);

  async function makeSeller(label: string, passwordHash: string) {
    const user = await prisma.user.create({
      data: {
        email: `theme-${label}-${suffix}@example.test`,
        name: `Theme ${label} ${suffix}`,
        role: Role.SELLER,
        passwordHash,
        emailVerifiedAt: new Date(),
        onboardingCompletedAt: new Date(),
      },
    });
    const seller = await prisma.seller.create({
      data: { userId: user.id, status: SellerStatus.APPROVED },
    });
    const store = await prisma.store.create({
      data: {
        sellerId: seller.id,
        name: `Theme ${label} Store ${suffix}`,
        slug: `theme-${label}-${suffix}`,
      },
    });
    return { user, seller, store };
  }

  const owner = await makeSeller("paid-owner", sellerTemplate.passwordHash);
  const freeOwner = await makeSeller("free-owner", sellerTemplate.passwordHash);
  const outsider = await makeSeller("outsider", sellerTemplate.passwordHash);
  const product = await prisma.product.create({
    data: {
      seller: { connect: { id: owner.seller.id } },
      productType: { connect: { slug: "physical-product" } },
      name: `Theme Product ${suffix}`,
      slug: `theme-product-${suffix}`,
      description: "Approved synthetic theme preview product",
      priceMinor: 3400,
      currency: "USD",
      status: ProductStatus.APPROVED,
      inventory: { create: { quantity: 3 } },
    },
  });
  const [budgetProduct, premiumProduct] = await Promise.all(
    [
      {
        key: "budget",
        name: `Theme Product Budget ${suffix}`,
        priceMinor: 1200,
      },
      {
        key: "premium",
        name: `Theme Product Premium ${suffix}`,
        priceMinor: 8900,
      },
    ].map(({ key, name, priceMinor }) =>
      prisma.product.create({
        data: {
          seller: { connect: { id: owner.seller.id } },
          productType: { connect: { slug: "physical-product" } },
          name,
          slug: `theme-product-${key}-${suffix}`,
          description: "Approved synthetic theme preview product",
          priceMinor,
          currency: "USD",
          status: ProductStatus.APPROVED,
          inventory: { create: { quantity: 3 } },
        },
      }),
    ),
  );
  const foreignProduct = await prisma.product.create({
    data: {
      seller: { connect: { id: outsider.seller.id } },
      productType: { connect: { slug: "physical-product" } },
      name: `Foreign Theme Product ${suffix}`,
      slug: `foreign-theme-product-${suffix}`,
      description: "Approved synthetic product owned by another Store",
      priceMinor: 4500,
      currency: "USD",
      status: ProductStatus.APPROVED,
      inventory: { create: { quantity: 3 } },
    },
  });

  async function makeThemeLogo(
    label: string,
    uploaderId: string,
    storeId: string,
    scanStatus: MediaScanStatus,
  ) {
    return prisma.mediaAsset.create({
      data: {
        storageKey: `theme-e2e/${suffix}/${label}.webp`,
        originalName: `${label}.webp`,
        safeName: `${label}.webp`,
        kind: MediaKind.IMAGE,
        detectedMime: "image/webp",
        sizeBytes: 64,
        checksum: randomUUID(),
        uploaderId,
        storeId,
        purpose: MediaPurpose.STORE_MEDIA,
        uploadStatus: MediaUploadStatus.COMPLETE,
        scanStatus,
        scanCompletedAt:
          scanStatus === MediaScanStatus.APPROVED ? new Date() : null,
        scannerProvider:
          scanStatus === MediaScanStatus.APPROVED ? "synthetic-e2e" : null,
      },
    });
  }
  const [approvedLogo, foreignLogo, quarantinedLogo] = await Promise.all([
    makeThemeLogo(
      "approved-owner-logo",
      owner.user.id,
      owner.store.id,
      MediaScanStatus.APPROVED,
    ),
    makeThemeLogo(
      "approved-foreign-logo",
      outsider.user.id,
      outsider.store.id,
      MediaScanStatus.APPROVED,
    ),
    makeThemeLogo(
      "quarantined-owner-logo",
      owner.user.id,
      owner.store.id,
      MediaScanStatus.QUARANTINED,
    ),
  ]);

  const plan = await prisma.storePlan.create({
    data: {
      key: `theme-paid-${suffix}`,
      name: `Theme Paid ${suffix}`,
      status: StorePlanStatus.ACTIVE,
    },
  });
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  const version = await prisma.storePlanVersion.create({
    data: {
      planId: plan.id,
      version: 1,
      status: StorePlanVersionStatus.ACTIVE,
      name: "Synthetic paid theme plan",
      monthlyPriceMinor: 2500,
      annualPriceMinor: 0,
      effectiveFrom: start,
      activatedAt: now,
      productLimit: 100,
      storeLimit: 1,
      vendorLimit: 1,
      staffSeatLimit: 5,
      allowedThemes: [...Object.values(StoreThemePreset)],
      mobileTemplates: [MobileStorefrontTemplate.RESPONSIVE_STANDARD],
    },
  });
  await prisma.storePlanAssignment.create({
    data: {
      storeId: owner.store.id,
      planVersionId: version.id,
      status: StorePlanAssignmentStatus.ACTIVE,
      source: StorePlanAssignmentSource.SUBSCRIPTION,
      effectiveFrom: start,
    },
  });
  const subscription = await prisma.storeSubscription.create({
    data: {
      storeId: owner.store.id,
      planVersionId: version.id,
      provider: StoreSubscriptionProvider.STRIPE,
      providerSubscriptionId: `synthetic-theme-sub-${suffix}`,
      status: StoreSubscriptionStatus.ACTIVE,
      interval: StorePlanBillingInterval.MONTHLY,
      currency: "USD",
      monthlyPriceMinor: 2500,
      annualPriceMinor: 0,
      freeTrialDays: 0,
      expirationBehavior: "DOWNGRADE_TO_LEGACY",
      cancellationPolicy: "CANCEL_ANYTIME",
      termsSnapshot: { syntheticFixture: true, noProviderCall: true },
      currentPeriodStart: start,
      currentPeriodEnd: end,
    },
  });
  const ownerAccount = await openAccount(browser, owner.user.email);
  const freeAccount = await openAccount(browser, freeOwner.user.email);
  const outsiderAccount = await openAccount(browser, outsider.user.email);
  const adminAccount = await openAccount(browser, "admin.local@example.test");
  const unauthorizedStaff = await prisma.user.create({
    data: {
      email: `theme-staff-${suffix}@example.test`,
      name: `Unauthorized theme staff ${suffix}`,
      role: Role.CASHIER,
      passwordHash: buyerTemplate.passwordHash,
      emailVerifiedAt: new Date(),
      onboardingCompletedAt: new Date(),
    },
  });
  await prisma.sellerStaff.create({
    data: {
      sellerId: owner.seller.id,
      userId: unauthorizedStaff.id,
      canManageStoreBranding: false,
    },
  });
  const staffAccount = await openAccount(browser, unauthorizedStaff.email);

  try {
    const ownerHeaders = await csrf(ownerAccount.context);
    const ownerThemeResponse = await ownerAccount.page.request.get(
      "/api/seller/store-theme",
    );
    expect(
      ownerThemeResponse.ok(),
      await ownerThemeResponse.text(),
    ).toBeTruthy();
    const ownerThemeData = (await ownerThemeResponse.json()) as {
      draft: Record<string, unknown>;
      draftVersion: number;
      themeAccess: { allowedThemes: string[]; premiumEligible: boolean };
      availableProducts: { id: string }[];
    };
    expect(ownerThemeData.themeAccess).toMatchObject({ premiumEligible: true });
    expect(ownerThemeData.themeAccess.allowedThemes).toContain(
      StoreThemePreset.TECH_ELECTRONICS,
    );
    expect(ownerThemeData.availableProducts.map((item) => item.id)).toContain(
      product.id,
    );

    const freeThemeResponse = await freeAccount.page.request.get(
      "/api/seller/store-theme",
    );
    const freeThemeData = (await freeThemeResponse.json()) as {
      themeAccess: { allowedThemes: string[]; premiumEligible: boolean };
    };
    expect(freeThemeData.themeAccess.premiumEligible).toBe(false);
    expect(freeThemeData.themeAccess.allowedThemes).toEqual(
      expect.arrayContaining([
        StoreThemePreset.CLASSIC,
        StoreThemePreset.EDITORIAL,
        StoreThemePreset.BOUTIQUE,
      ]),
    );
    expect(freeThemeData.themeAccess.allowedThemes).not.toContain(
      StoreThemePreset.TECH_ELECTRONICS,
    );

    const deniedFreeSave = await freeAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: { themePreset: StoreThemePreset.GROCERIES, expectedVersion: 0 },
        headers: await csrf(freeAccount.context),
      },
    );
    expect(deniedFreeSave.status(), await deniedFreeSave.text()).toBe(409);

    const unauthorized = await staffAccount.page.request.get(
      "/api/seller/store-theme",
    );
    expect(unauthorized.status(), await unauthorized.text()).toBe(403);

    const themeDraft = {
      ...(ownerThemeData.draft as Record<string, unknown>),
      themePreset: StoreThemePreset.TECH_ELECTRONICS,
      heroTitle: `Approved electronics ${suffix}`,
      sections: [
        {
          type: "featuredProducts",
          title: "Featured items",
          productIds: [product.id],
          categorySlug: null,
          visible: true,
        },
      ],
      expectedVersion: 0,
      changeNote: `Publish synthetic paid theme ${suffix}`,
    };
    const foreignLogoSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: { ...themeDraft, logoMediaId: foreignLogo.id },
        headers: ownerHeaders,
      },
    );
    expect(foreignLogoSave.status(), await foreignLogoSave.text()).toBe(400);

    const quarantinedSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: { ...themeDraft, logoMediaId: quarantinedLogo.id },
        headers: ownerHeaders,
      },
    );
    expect(quarantinedSave.status(), await quarantinedSave.text()).toBe(200);
    const quarantinedPublish = await ownerAccount.page.request.post(
      "/api/seller/store-theme/publish",
      { data: { expectedVersion: 1 }, headers: ownerHeaders },
    );
    expect(quarantinedPublish.status(), await quarantinedPublish.text()).toBe(
      409,
    );

    const approvedLogoSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: {
          ...themeDraft,
          expectedVersion: 1,
          logoMediaId: approvedLogo.id,
        },
        headers: ownerHeaders,
      },
    );
    expect(approvedLogoSave.status(), await approvedLogoSave.text()).toBe(200);
    const clearLogoDraft = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: {
          ...themeDraft,
          expectedVersion: 2,
          logoMediaId: null,
        },
        headers: ownerHeaders,
      },
    );
    expect(clearLogoDraft.status(), await clearLogoDraft.text()).toBe(200);

    const initialVersion = 3;
    themeDraft.expectedVersion = initialVersion;
    const saved = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      { data: themeDraft, headers: ownerHeaders },
    );
    expect(saved.status(), await saved.text()).toBe(200);
    const savedBody = (await saved.json()) as { draftVersion: number };
    expect(savedBody.draftVersion).toBe(4);

    const staleSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: { ...themeDraft, expectedVersion: initialVersion },
        headers: ownerHeaders,
      },
    );
    expect(staleSave.status(), await staleSave.text()).toBe(409);
    const stillPrivate = await ownerAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect((await stillPrivate.json()).theme.themePreset).toBe(
      StoreThemePreset.CLASSIC,
    );

    const publish = await ownerAccount.page.request.post(
      "/api/seller/store-theme/publish",
      { data: { expectedVersion: 4 }, headers: ownerHeaders },
    );
    expect(publish.status(), await publish.text()).toBe(200);
    const stalePublish = await ownerAccount.page.request.post(
      "/api/seller/store-theme/publish",
      { data: { expectedVersion: initialVersion }, headers: ownerHeaders },
    );
    expect(stalePublish.status(), await stalePublish.text()).toBe(409);

    await ownerAccount.page.goto("/seller/themes");
    await expect(
      ownerAccount.page.getByRole("heading", {
        name: "Themes & Templates Studio",
      }),
    ).toBeVisible();
    const published = await ownerAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect(published.status()).toBe(200);
    const publishedBody = (await published.json()) as {
      theme: {
        themePreset: string;
        heroTitle: string;
        sections: { productIds: string[] }[];
      };
      products: { id: string }[];
    };
    expect(publishedBody.theme).toMatchObject({
      themePreset: StoreThemePreset.TECH_ELECTRONICS,
      heroTitle: `Approved electronics ${suffix}`,
    });
    expect(publishedBody.theme.sections[0]?.productIds).toEqual([product.id]);
    expect(publishedBody.products.map((item) => item.id)).toEqual(
      expect.arrayContaining([product.id, budgetProduct.id, premiumProduct.id]),
    );

    const foreignProductSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: {
          ...themeDraft,
          expectedVersion: 4,
          sections: [
            {
              type: "featuredProducts",
              title: "Foreign product",
              productIds: [foreignProduct.id],
              categorySlug: null,
              visible: true,
            },
          ],
        },
        headers: ownerHeaders,
      },
    );
    expect(foreignProductSave.status(), await foreignProductSave.text()).toBe(
      400,
    );
    const otherStore = await outsiderAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect(otherStore.status()).toBe(200);
    expect((await otherStore.json()).storeId).toBe(owner.store.id);
    const outsiderTheme = await outsiderAccount.page.request.get(
      "/api/seller/store-theme",
    );
    expect((await outsiderTheme.json()).storeId).toBe(outsider.store.id);

    let themeVersion = 4;
    for (const preset of Object.values(StoreThemePreset)) {
      const response = await ownerAccount.page.request.put(
        "/api/seller/store-theme",
        {
          data: {
            ...themeDraft,
            themePreset: preset,
            expectedVersion: themeVersion,
            changeNote: `Acceptance preview ${preset}`,
          },
          headers: ownerHeaders,
        },
      );
      expect(response.status(), await response.text()).toBe(200);
      themeVersion += 1;
      const publishedTheme = await ownerAccount.page.request.post(
        "/api/seller/store-theme/publish",
        { data: { expectedVersion: themeVersion }, headers: ownerHeaders },
      );
      expect(publishedTheme.status(), await publishedTheme.text()).toBe(200);

      await ownerAccount.page.setViewportSize({ width: 1440, height: 1000 });
      await ownerAccount.page.goto(`/store/${owner.store.slug}`);
      const storefront = ownerAccount.page.locator(
        `.storeFront[data-store-theme="${preset}"]`,
      );
      await expect(storefront).toBeVisible();
      if (preset === StoreThemePreset.ECOMMERCE_MARKETPLACE) {
        await ownerAccount.page
          .getByRole("combobox", { name: "Sort storefront products" })
          .selectOption("price-asc");
        await expect(
          ownerAccount.page.locator(
            ".storefrontProductCard > .cardBody > h2 > a",
          ),
        ).toHaveText([budgetProduct.name, product.name, premiumProduct.name]);
      }
      await testInfo.attach(`${preset.toLowerCase()}-desktop`, {
        body: await ownerAccount.page.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
      await ownerAccount.page.setViewportSize({ width: 390, height: 844 });
      await expect(storefront).toBeVisible();
      const mobileFits = await storefront.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      );
      expect(
        mobileFits,
        `${preset} storefront should not overflow on mobile`,
      ).toBe(true);
      await testInfo.attach(`${preset.toLowerCase()}-mobile`, {
        body: await ownerAccount.page.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
    }

    const groceriesDraft = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: {
          ...themeDraft,
          themePreset: StoreThemePreset.GROCERIES,
          expectedVersion: themeVersion,
          changeNote: "Verify admin visibility policy and public fallback",
        },
        headers: ownerHeaders,
      },
    );
    expect(groceriesDraft.status(), await groceriesDraft.text()).toBe(200);
    themeVersion += 1;
    const groceriesPublish = await ownerAccount.page.request.post(
      "/api/seller/store-theme/publish",
      { data: { expectedVersion: themeVersion }, headers: ownerHeaders },
    );
    expect(groceriesPublish.status(), await groceriesPublish.text()).toBe(200);

    const adminCatalogResponse = await adminAccount.page.request.get(
      "/api/admin/store-themes",
    );
    expect(adminCatalogResponse.status()).toBe(200);
    const adminCatalog = (await adminCatalogResponse.json()) as {
      themes: { id: string; available: boolean }[];
      config: {
        displayOrder: string[];
        visibleThemes: string[];
        tokens: Record<string, unknown>;
      };
      configUpdatedAt: string | null;
    };
    expect(adminCatalog.themes).toHaveLength(6);
    const adminHeaders = await csrf(adminAccount.context);
    await adminAccount.page.goto("/admin/platform?section=themes");
    await expect(
      adminAccount.page.getByRole("heading", {
        name: "Themes & Templates Management",
      }),
    ).toBeVisible();
    const classicToggle = adminAccount.page.getByRole("checkbox", {
      name: "Make Classic available to eligible Stores",
    });
    await expect(classicToggle).toBeChecked();
    await expect(classicToggle).toBeDisabled();
    const groceriesToggle = adminAccount.page.getByRole("checkbox", {
      name: "Make Groceries available to eligible Stores",
    });
    await expect(groceriesToggle).toBeChecked();
    await groceriesToggle.uncheck();
    const hideCatalogRequest = adminAccount.page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/store-themes/catalog") &&
        response.request().method() === "PUT",
    );
    await adminAccount.page
      .getByRole("button", { name: "Save catalog configuration" })
      .click();
    const hideCatalogResponse = await hideCatalogRequest;
    expect(hideCatalogResponse.status(), await hideCatalogResponse.text()).toBe(
      200,
    );
    await expect(
      adminAccount.page.locator(
        ".storeThemesAdmin > p[role='status'][aria-live='polite']",
      ),
    ).toContainText("Theme catalog defaults and order saved", {
      timeout: 15_000,
    });
    const hiddenResponse = await adminAccount.page.request.get(
      "/api/admin/store-themes",
    );
    const hiddenCatalog = (await hiddenResponse.json()) as typeof adminCatalog;
    expect(
      hiddenCatalog.themes.find(
        (theme) => theme.id === StoreThemePreset.GROCERIES,
      )?.available,
    ).toBe(false);
    const hiddenUpdatedAt = hiddenCatalog.configUpdatedAt;
    const hiddenSellerTheme = await ownerAccount.page.request.get(
      "/api/seller/store-theme",
    );
    expect(
      (await hiddenSellerTheme.json()).themeAccess.allowedThemes,
    ).not.toContain(StoreThemePreset.GROCERIES);
    const hiddenPublicCatalog = await ownerAccount.page.request.get(
      "/api/store-themes/catalog",
    );
    expect(
      (await hiddenPublicCatalog.json()).themes.map(
        (theme: { id: string }) => theme.id,
      ),
    ).not.toContain(StoreThemePreset.GROCERIES);
    const hiddenPublished = await ownerAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect((await hiddenPublished.json()).theme.themePreset).toBe(
      StoreThemePreset.CLASSIC,
    );
    expect(
      await prisma.store.findUniqueOrThrow({ where: { id: owner.store.id } }),
    ).toMatchObject({
      themePublishedJson: { themePreset: StoreThemePreset.GROCERIES },
    });
    const hiddenSave = await ownerAccount.page.request.put(
      "/api/seller/store-theme",
      {
        data: {
          ...themeDraft,
          themePreset: StoreThemePreset.GROCERIES,
          expectedVersion: themeVersion,
        },
        headers: ownerHeaders,
      },
    );
    expect(hiddenSave.status(), await hiddenSave.text()).toBe(409);

    const classicHiddenResponse = await adminAccount.page.request.put(
      "/api/admin/store-themes/catalog",
      {
        data: {
          config: {
            ...hiddenCatalog.config,
            visibleThemes: hiddenCatalog.config.visibleThemes.filter(
              (preset) => preset !== StoreThemePreset.CLASSIC,
            ),
          },
          expectedUpdatedAt: hiddenUpdatedAt,
          reason: "Attempt to hide the required safe Classic fallback",
        },
        headers: adminHeaders,
      },
    );
    expect(classicHiddenResponse.status()).toBe(400);
    await groceriesToggle.check();
    const restoreCatalogRequest = adminAccount.page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/store-themes/catalog") &&
        response.request().method() === "PUT",
    );
    await adminAccount.page
      .getByRole("button", { name: "Save catalog configuration" })
      .click();
    const restoreCatalogResponse = await restoreCatalogRequest;
    expect(
      restoreCatalogResponse.status(),
      await restoreCatalogResponse.text(),
    ).toBe(200);
    await expect(
      adminAccount.page.locator(
        ".storeThemesAdmin > p[role='status'][aria-live='polite']",
      ),
    ).toContainText("Theme catalog defaults and order saved", {
      timeout: 15_000,
    });
    const restoredCatalog = await adminAccount.page.request.get(
      "/api/admin/store-themes",
    );
    expect(
      ((await restoredCatalog.json()) as typeof adminCatalog).config
        .visibleThemes,
    ).toContain(StoreThemePreset.GROCERIES);
    expect(
      (
        await (
          await ownerAccount.page.request.get(`/api/stores/${owner.store.slug}`)
        ).json()
      ).theme.themePreset,
    ).toBe(StoreThemePreset.GROCERIES);

    const revisionsResponse = await ownerAccount.page.request.get(
      "/api/seller/store-theme/revisions",
    );
    const revisions = (await revisionsResponse.json()).revisions as {
      id: string;
      version: number;
    }[];
    const revisionToRestore = revisions.find(
      (revision) => revision.version === themeVersion - 1,
    );
    expect(revisionToRestore).toBeTruthy();
    const restore = await ownerAccount.page.request.post(
      `/api/seller/store-theme/revisions/${revisionToRestore!.id}/restore`,
      { data: { expectedVersion: themeVersion }, headers: ownerHeaders },
    );
    expect(restore.status(), await restore.text()).toBe(200);
    const staleRestore = await ownerAccount.page.request.post(
      `/api/seller/store-theme/revisions/${revisionToRestore!.id}/restore`,
      { data: { expectedVersion: themeVersion }, headers: ownerHeaders },
    );
    expect(staleRestore.status(), await staleRestore.text()).toBe(409);
    const crossStoreRestore = await outsiderAccount.page.request.post(
      `/api/seller/store-theme/revisions/${revisionToRestore!.id}/restore`,
      {
        data: { expectedVersion: 0 },
        headers: await csrf(outsiderAccount.context),
      },
    );
    expect(crossStoreRestore.status(), await crossStoreRestore.text()).toBe(
      404,
    );

    const freePublic = await freeAccount.page.request.get(
      `/api/stores/${freeOwner.store.slug}`,
    );
    expect((await freePublic.json()).theme.themePreset).toBe(
      StoreThemePreset.CLASSIC,
    );
    await prisma.storeSubscription.update({
      where: { id: subscription.id },
      data: {
        status: StoreSubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });
    const downgraded = await ownerAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect((await downgraded.json()).theme.themePreset).toBe(
      StoreThemePreset.CLASSIC,
    );
    expect(
      (await prisma.store.findUniqueOrThrow({ where: { id: owner.store.id } }))
        .themePublishedJson,
    ).toMatchObject({ themePreset: StoreThemePreset.GROCERIES });
    await prisma.storeSubscription.update({
      where: { id: subscription.id },
      data: { status: StoreSubscriptionStatus.ACTIVE, cancelledAt: null },
    });
    const reactivated = await ownerAccount.page.request.get(
      `/api/stores/${owner.store.slug}`,
    );
    expect((await reactivated.json()).theme.themePreset).toBe(
      StoreThemePreset.GROCERIES,
    );
  } finally {
    await Promise.all([
      ownerAccount.context.close(),
      freeAccount.context.close(),
      outsiderAccount.context.close(),
      adminAccount.context.close(),
      staffAccount.context.close(),
    ]);
  }
});
