import {
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
} from "@prisma/client";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required; SEO-FY browser tests use the guarded disposable database.",
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

async function csrfHeaders(context: BrowserContext) {
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  return { "x-csrf-token": csrf! };
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

test("SEO-FY is paid-plan, tenant, approval, and privacy scoped end to end", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().replaceAll("-", "");
  const sellerTemplate = await prisma.user.findUniqueOrThrow({
    where: { email: "seller.local@example.test" },
    select: { passwordHash: true },
  });
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: "admin.local@example.test" },
    select: { id: true },
  });

  async function makeSeller(label: string) {
    const user = await prisma.user.create({
      data: {
        email: `seofy-${label}-${suffix}@example.test`,
        name: `SEO-FY ${label} ${suffix}`,
        role: Role.SELLER,
        passwordHash: sellerTemplate.passwordHash,
        emailVerifiedAt: new Date(),
        onboardingCompletedAt: new Date(),
        seller: {
          create: {
            status: SellerStatus.APPROVED,
            store: {
              create: {
                name: `SEO-FY ${label} Store ${suffix}`,
                slug: `seofy-${label}-${suffix}`,
                description:
                  "Thoughtfully selected home and lifestyle products with clear material, care, and everyday-use details for shoppers comparing dependable options.",
              },
            },
          },
        },
      },
      include: { seller: { include: { store: true } } },
    });
    const seller = user.seller;
    const store = seller?.store;
    if (!seller || !store)
      throw new Error("Synthetic SEO-FY seller fixture was not created.");
    return { user, seller, store };
  }

  const owner = await makeSeller("paid-owner");
  const outsider = await makeSeller("paid-outsider");
  const freeSeller = await makeSeller("free-seller");
  const adminAssignedSeller = await makeSeller("admin-assigned");
  const productType = await prisma.catalogProductType.findUniqueOrThrow({
    where: { slug: "physical-product" },
  });

  async function makeProduct(label: string, sellerId: string) {
    return prisma.product.create({
      data: {
        sellerId,
        productTypeId: productType.id,
        name: `SEO-FY ${label} Ceramic Mug`,
        slug: `seofy-${label}-${suffix}`,
        description:
          "A durable glazed ceramic mug with a comfortable handle for everyday coffee and tea. Its practical shape fits common kitchen shelves, and the smooth finish is easy to clean after normal daily use.",
        priceMinor: 2500,
        currency: "USD",
        status: ProductStatus.APPROVED,
        inventory: { create: { quantity: 7 } },
      },
      include: { inventory: true },
    });
  }

  const product = await makeProduct("owner", owner.seller.id);
  const staleProduct = await makeProduct("stale", owner.seller.id);
  const foreignProduct = await makeProduct("foreign", outsider.seller.id);

  const plan = await prisma.storePlan.create({
    data: {
      key: `seofy-e2e-${suffix}`,
      name: "Synthetic SEO-FY paid plan",
      status: StorePlanStatus.ACTIVE,
    },
  });
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  const paidVersion = await prisma.storePlanVersion.create({
    data: {
      planId: plan.id,
      version: 1,
      status: StorePlanVersionStatus.ACTIVE,
      name: "Synthetic SEO-FY paid version",
      monthlyPriceMinor: 2500,
      annualPriceMinor: 0,
      effectiveFrom: start,
      activatedAt: now,
      productLimit: 100,
      storeLimit: 1,
      vendorLimit: 1,
      staffSeatLimit: 5,
      seofyEnabled: true,
    },
  });

  async function grantPaidPlan(storeId: string, label: string) {
    await prisma.storePlanAssignment.create({
      data: {
        storeId,
        planVersionId: paidVersion.id,
        status: StorePlanAssignmentStatus.ACTIVE,
        source: StorePlanAssignmentSource.SUBSCRIPTION,
        effectiveFrom: start,
      },
    });
    await prisma.storeSubscription.create({
      data: {
        storeId,
        planVersionId: paidVersion.id,
        provider: StoreSubscriptionProvider.STRIPE,
        providerSubscriptionId: `synthetic-seofy-${label}-${suffix}`,
        status: StoreSubscriptionStatus.ACTIVE,
        interval: StorePlanBillingInterval.MONTHLY,
        currency: "USD",
        monthlyPriceMinor: 2500,
        annualPriceMinor: 0,
        freeTrialDays: 0,
        expirationBehavior: "DOWNGRADE_TO_LEGACY",
        cancellationPolicy: "CANCEL_ANYTIME",
        termsSnapshot: { syntheticFixture: true, providerContacted: false },
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
  }

  await grantPaidPlan(owner.store.id, "owner");
  await grantPaidPlan(outsider.store.id, "outsider");
  await prisma.storePlanAssignment.create({
    data: {
      storeId: adminAssignedSeller.store.id,
      planVersionId: paidVersion.id,
      status: StorePlanAssignmentStatus.ACTIVE,
      source: StorePlanAssignmentSource.ADMIN,
      assignedById: admin.id,
      effectiveFrom: start,
      reason:
        "Synthetic non-subscription SEO-FY entitlement regression fixture",
    },
  });

  const ownerAccount = await openAccount(browser, owner.user.email);
  const outsiderAccount = await openAccount(browser, outsider.user.email);
  const freeAccount = await openAccount(browser, freeSeller.user.email);
  const adminAssignedAccount = await openAccount(
    browser,
    adminAssignedSeller.user.email,
  );
  const adminAccount = await openAccount(browser, "admin.local@example.test");

  try {
    const ownerStateResponse =
      await ownerAccount.page.request.get("/api/seller/seofy");
    expect(ownerStateResponse.ok()).toBeTruthy();
    const ownerState = (await ownerStateResponse.json()) as {
      store: { id: string };
      entitlement: { enabled: boolean };
      products: { id: string }[];
    };
    expect(ownerState.store.id).toBe(owner.store.id);
    expect(ownerState.entitlement.enabled).toBe(true);
    expect(ownerState.products.map(({ id }) => id)).toContain(product.id);
    expect(ownerState.products.map(({ id }) => id)).not.toContain(
      foreignProduct.id,
    );

    const ownerDashboardResponse = await ownerAccount.page.request.get(
      "/api/dashboard/seller",
    );
    expect(ownerDashboardResponse.ok()).toBeTruthy();
    expect(
      (await ownerDashboardResponse.json()).entitlements.seofyEnabled,
    ).toBe(true);

    await ownerAccount.page.goto("/dashboard?mode=seller");
    await expect(
      ownerAccount.page.getByRole("link", { name: "SEO-FY audit" }),
    ).toBeVisible();

    await ownerAccount.page.goto("/seller/seofy");
    await expect(
      ownerAccount.page.getByRole("heading", { name: "SEO-FY" }),
    ).toBeVisible();
    await expect(ownerAccount.page.getByText("Paid plan active")).toBeVisible();
    const storeBefore = await prisma.store.findUniqueOrThrow({
      where: { id: owner.store.id },
      select: {
        name: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
      },
    });

    const storeAuditRequest = ownerAccount.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/seller/seofy/audits",
    );
    await ownerAccount.page
      .getByRole("button", { name: "Run SEO audit" })
      .click();
    const storeAuditResponse = await storeAuditRequest;
    expect(storeAuditResponse.status(), await storeAuditResponse.text()).toBe(
      201,
    );
    await expect(
      ownerAccount.page.getByRole("heading", { name: "Audit findings" }),
    ).toBeVisible();
    const storeAudit = await prisma.seofyAudit.findFirstOrThrow({
      where: { storeId: owner.store.id, targetId: owner.store.id },
      include: { suggestions: true },
      orderBy: { createdAt: "desc" },
    });
    expect(storeAudit.suggestions.length).toBeGreaterThan(0);
    expect(
      await prisma.store.findUniqueOrThrow({
        where: { id: owner.store.id },
        select: {
          name: true,
          description: true,
          seoTitle: true,
          seoDescription: true,
        },
      }),
    ).toEqual(storeBefore);
    const applyStoreButton = ownerAccount.page.getByRole("button", {
      name: /Approve & apply selected \(0\)/,
    });
    await expect(applyStoreButton).toBeDisabled();
    await ownerAccount.page.locator(".seofySuggestion input").first().check();
    await ownerAccount.page
      .getByRole("button", { name: /Approve & apply selected \(1\)/ })
      .click();
    await expect(
      ownerAccount.page.getByRole("status").filter({
        hasText: "Approved SEO metadata was saved.",
      }),
    ).toBeVisible();
    const storeAfter = await prisma.store.findUniqueOrThrow({
      where: { id: owner.store.id },
      select: {
        name: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
      },
    });
    expect(storeAfter.name).toBe(storeBefore.name);
    expect(storeAfter.description).toBe(storeBefore.description);
    expect(storeAfter.seoTitle ?? storeAfter.seoDescription).toBeTruthy();
    expect(
      await prisma.auditLog.count({
        where: {
          actorId: owner.user.id,
          action: "SEOFY_SUGGESTIONS_APPLIED",
          entityId: storeAudit.id,
        },
      }),
    ).toBe(1);

    const productBefore = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { inventory: true },
    });
    await ownerAccount.page.getByLabel("Audit target").selectOption(product.id);
    const productAuditRequest = ownerAccount.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/seller/seofy/audits",
    );
    await ownerAccount.page
      .getByRole("button", { name: "Run SEO audit" })
      .click();
    const productAuditResponse = await productAuditRequest;
    expect(
      productAuditResponse.status(),
      await productAuditResponse.text(),
    ).toBe(201);
    const productAudit = await prisma.seofyAudit.findFirstOrThrow({
      where: { storeId: owner.store.id, targetId: product.id },
      include: { suggestions: true },
      orderBy: { createdAt: "desc" },
    });
    expect(productAudit.suggestions.length).toBeGreaterThan(0);
    expect(
      await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        include: { inventory: true },
      }),
    ).toMatchObject({
      seoTitle: productBefore.seoTitle,
      seoDescription: productBefore.seoDescription,
      priceMinor: productBefore.priceMinor,
      status: productBefore.status,
      inventory: { quantity: productBefore.inventory?.quantity },
    });
    await ownerAccount.page.locator(".seofySuggestion input").first().check();
    await ownerAccount.page
      .getByRole("button", { name: /Approve & apply selected \(1\)/ })
      .click();
    await expect(
      ownerAccount.page.getByRole("status").filter({
        hasText: "Approved SEO metadata was saved.",
      }),
    ).toBeVisible();
    const productAfter = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { inventory: true },
    });
    expect(productAfter.seoTitle ?? productAfter.seoDescription).toBeTruthy();
    expect(productAfter.priceMinor).toBe(productBefore.priceMinor);
    expect(productAfter.status).toBe(productBefore.status);
    expect(productAfter.inventory?.quantity).toBe(
      productBefore.inventory?.quantity,
    );

    const appliedSuggestion = productAudit.suggestions[0];
    if (!appliedSuggestion)
      throw new Error("The synthetic product audit has no suggestion.");
    const retryResponse = await ownerAccount.page.request.post(
      `/api/seller/seofy/audits/${encodeURIComponent(productAudit.id)}/apply`,
      {
        headers: await csrfHeaders(ownerAccount.context),
        data: { suggestionIds: [appliedSuggestion.id] },
      },
    );
    expect(retryResponse.status()).toBe(409);

    const staleAuditResponse = await ownerAccount.page.request.post(
      "/api/seller/seofy/audits",
      {
        headers: await csrfHeaders(ownerAccount.context),
        data: { targetType: "PRODUCT", targetId: staleProduct.id },
      },
    );
    expect(staleAuditResponse.status()).toBe(201);
    const staleAudit = (await staleAuditResponse.json()) as {
      id: string;
      suggestions: { id: string }[];
    };
    expect(staleAudit.suggestions.length).toBeGreaterThan(0);
    await prisma.product.update({
      where: { id: staleProduct.id },
      data: {
        description: "The owner edited this synthetic product after the audit.",
      },
    });
    const staleApplyResponse = await ownerAccount.page.request.post(
      `/api/seller/seofy/audits/${encodeURIComponent(staleAudit.id)}/apply`,
      {
        headers: await csrfHeaders(ownerAccount.context),
        data: { suggestionIds: [staleAudit.suggestions[0]!.id] },
      },
    );
    expect(staleApplyResponse.status()).toBe(409);
    expect(
      await prisma.seofyAudit.findUniqueOrThrow({
        where: { id: staleAudit.id },
      }),
    ).toMatchObject({ status: "STALE" });

    const foreignAuditResponse = await ownerAccount.page.request.post(
      "/api/seller/seofy/audits",
      {
        headers: await csrfHeaders(ownerAccount.context),
        data: { targetType: "PRODUCT", targetId: foreignProduct.id },
      },
    );
    expect(foreignAuditResponse.status()).toBe(404);
    const crossTenantApply = await outsiderAccount.page.request.post(
      `/api/seller/seofy/audits/${encodeURIComponent(storeAudit.id)}/apply`,
      {
        headers: await csrfHeaders(outsiderAccount.context),
        data: { suggestionIds: [storeAudit.suggestions[0]!.id] },
      },
    );
    expect(crossTenantApply.status()).toBe(404);

    const freeState = await freeAccount.page.request.get("/api/seller/seofy");
    expect(freeState.ok()).toBeTruthy();
    expect((await freeState.json()).entitlement.enabled).toBe(false);
    const freeDashboardResponse = await freeAccount.page.request.get(
      "/api/dashboard/seller",
    );
    expect(freeDashboardResponse.ok()).toBeTruthy();
    expect((await freeDashboardResponse.json()).entitlements.seofyEnabled).toBe(
      false,
    );
    await freeAccount.page.goto("/dashboard?mode=seller");
    await expect(
      freeAccount.page.getByRole("link", { name: "SEO-FY audit" }),
    ).toHaveCount(0);
    const forgedEntitlement = await freeAccount.page.request.post(
      "/api/seller/seofy/audits",
      {
        headers: await csrfHeaders(freeAccount.context),
        data: { targetType: "STORE", seofyEnabled: true },
      },
    );
    expect(forgedEntitlement.status()).toBe(400);
    const freeAudit = await freeAccount.page.request.post(
      "/api/seller/seofy/audits",
      {
        headers: await csrfHeaders(freeAccount.context),
        data: { targetType: "STORE" },
      },
    );
    expect(freeAudit.status()).toBe(403);
    await freeAccount.page.goto("/seller/seofy");
    await expect(
      freeAccount.page.getByText("Available with an eligible paid Store plan"),
    ).toBeVisible();
    await expect(
      freeAccount.page.getByRole("button", { name: "Run SEO audit" }),
    ).toBeDisabled();

    const adminOnlyState =
      await adminAssignedAccount.page.request.get("/api/seller/seofy");
    expect((await adminOnlyState.json()).entitlement.enabled).toBe(false);
    const adminOnlyAudit = await adminAssignedAccount.page.request.post(
      "/api/seller/seofy/audits",
      {
        headers: await csrfHeaders(adminAssignedAccount.context),
        data: { targetType: "STORE" },
      },
    );
    expect(adminOnlyAudit.status()).toBe(403);

    const sellerMetrics = await ownerAccount.page.request.get(
      "/api/admin/seofy/metrics",
    );
    expect(sellerMetrics.status()).toBe(403);
    const metricsResponse = await adminAccount.page.request.get(
      "/api/admin/seofy/metrics",
    );
    expect(metricsResponse.ok()).toBeTruthy();
    const metrics = await metricsResponse.json();
    expect(metrics).toMatchObject({
      sellerDetailsExposed: false,
      windowDays: 30,
    });
    expect(JSON.stringify(metrics)).not.toContain(owner.store.name);
    await adminAccount.page.goto("/admin/platform?section=jima");
    await expect(
      adminAccount.page.getByRole("heading", { name: "SEO-FY operations" }),
    ).toBeVisible();
    await expect(
      adminAccount.page.getByText("This view contains no Store names"),
    ).toBeVisible();
  } finally {
    await Promise.all([
      ownerAccount.context.close(),
      outsiderAccount.context.close(),
      freeAccount.context.close(),
      adminAssignedAccount.context.close(),
      adminAccount.context.close(),
    ]);
  }
});
