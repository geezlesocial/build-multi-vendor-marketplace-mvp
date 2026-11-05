import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./layout-assertions.js";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";

const password = "LocalDemoOnly-ChangeMe-123!";
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error("E2E_DATABASE_URL is required for dashboard browser tests.");
const prisma = createTestPrismaClient(databaseUrl);
test.afterAll(async () => {
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function cartSummaryValue(page: Page) {
  return page
    .getByRole("region", { name: "Buyer account summary" })
    .locator(".dashboardMetric")
    .filter({ hasText: "Items in cart" })
    .locator(".dashboardMetricValue");
}

test("buyer dashboard exposes buyer modules and denies seller-scoped data", async ({
  page,
}) => {
  await login(page, "buyer.local@example.test");
  await expect((await page.request.get("/api/dashboard/seller")).status()).toBe(
    403,
  );
  const buyerDataResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/dashboard/buyer") &&
      response.request().method() === "GET",
  );
  await page.goto("/dashboard");
  const buyerDataResponse = await buyerDataResponsePromise;
  expect(buyerDataResponse.ok(), await buyerDataResponse.text()).toBeTruthy();
  const buyerData = (await buyerDataResponse.json()) as { orders: unknown[] };
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Buyer view" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Seller view" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Orders", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cart" })).toBeVisible();
  if (buyerData.orders.length === 0) {
    await expect(
      page.getByRole("link", { name: "Browse products" }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", { name: "Recent orders" }),
    ).toBeVisible();
  }
});

test("approved seller can switch dashboards and view only the public store link", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  const storeResponse = await page.request.get("/api/seller/store-theme");
  expect(storeResponse.ok(), await storeResponse.text()).toBeTruthy();
  const store = (await storeResponse.json()) as {
    publicPath: string;
    name: string;
  };

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Seller view" }).click();
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Orders & fulfillment" })
      .getByRole("button", { name: "Orders" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Store" }).click();
  await expect(page.getByText(store.name)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View store", exact: true }),
  ).toHaveAttribute("href", store.publicPath);
  await expect(
    (await page.request.get("/api/dashboard/buyer")).ok(),
  ).toBeTruthy();
});

test("seller workspace switching survives direct URLs, refresh, and browser history", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  await page.goto("/dashboard?mode=buyer");
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Seller view" }).click();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller/);
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Seller view" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Buyer view" }).click();
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller/);
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
});

test("seller currency and commission dashboard tabs open from direct URLs and navigation", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  await page.goto("/dashboard?mode=seller&tab=currency");
  await expect(
    page.getByRole("heading", { name: "Currency and display" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Currency", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Currency and display" }),
  ).toBeVisible();

  const dashboardButton = page.getByRole("button", {
    name: "Back to dashboard",
  });
  await expect(dashboardButton).toBeVisible();
  await dashboardButton.click();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller$/);
  await page.getByRole("button", { name: "Currency", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Currency and display" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Commission", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller&tab=commission/);
  await expect(
    page.getByRole("heading", { name: "Commission and adjustments" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Commission", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("standalone seller modules share safe previous-page and dashboard navigation", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  await page.goto("/seller/currency");
  await expect(
    page.getByRole("heading", { name: "Currency and display" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go back to the previous page" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to dashboard" }),
  ).toHaveAttribute("href", "/dashboard?mode=seller");
  await expect(
    page.getByRole("link", { name: "Back to dashboard" }),
  ).toHaveCount(1);
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard\?mode=seller$/);
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
});

test("seller dashboard renders historical gross totals separately with explicit currency codes", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  await page.route("**/api/dashboard/seller", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        store: {},
        summary: {
          orderCount: 205,
          grossByCurrency: [
            { currency: "JPY", grossMinor: 2_060_000 },
            { currency: "USD", grossMinor: 1_020_000 },
          ],
        },
        products: [],
        orders: [],
        conversations: [],
        payoutMethods: [],
        payouts: [],
        live: {
          effectiveEnabled: false,
          deploymentGate: false,
          reason: "Disabled for this test.",
        },
      }),
    }),
  );
  await page.goto("/dashboard?mode=seller");
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
  const sellerSummary = page.getByRole("region", {
    name: "Seller account summary",
  });
  await expect(sellerSummary.getByText("Gross sales (JPY)")).toBeVisible();
  await expect(
    sellerSummary.getByText("¥2,060,000", { exact: true }),
  ).toBeVisible();
  await expect(sellerSummary.getByText("Gross sales (USD)")).toBeVisible();
  await expect(
    sellerSummary.getByText("$10,200.00", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$30,800.00", { exact: true })).toHaveCount(0);
});

test("buyer direct seller URL stays on the onboarding path and does not request seller data", async ({
  page,
}) => {
  await login(page, "buyer.local@example.test");
  let sellerDataRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/dashboard/seller"))
      sellerDataRequests += 1;
  });
  await expect((await page.request.get("/api/dashboard/seller")).status()).toBe(
    403,
  );
  await page.goto("/dashboard?mode=seller");
  await expect(
    page.getByRole("heading", { name: "Seller access is not active yet" }),
  ).toBeVisible();
  expect(sellerDataRequests).toBe(0);
  await page.getByRole("link", { name: "Return to buyer workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
});

test("a slower seller response cannot switch away from the buyer workspace", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  await page.goto("/dashboard");
  let releaseSellerResponse!: () => void;
  let signalSellerRequest!: () => void;
  const holdSellerResponse = new Promise<void>((resolve) => {
    releaseSellerResponse = resolve;
  });
  const sellerRequestStarted = new Promise<void>((resolve) => {
    signalSellerRequest = resolve;
  });
  await page.route("**/api/dashboard/seller", async (route) => {
    signalSellerRequest();
    await holdSellerResponse;
    await route.continue();
  });

  await page.getByRole("button", { name: "Seller view" }).click();
  await sellerRequestStarted;
  await page.getByRole("button", { name: "Buyer view" }).click();
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  const delayedSellerResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/dashboard/seller"),
  );
  releaseSellerResponse();
  const sellerResponse = await delayedSellerResponse;
  expect(sellerResponse.ok()).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  await page.unroute("**/api/dashboard/seller");
  await page.getByRole("button", { name: "Seller view" }).click();
  await expect(page.getByRole("button", { name: "Products" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
});

test("seller dashboard reports a failed refresh and supports retry", async ({
  page,
}) => {
  await login(page, "seller.local@example.test");
  let failedOnce = false;
  await page.route("**/api/dashboard/seller", async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary dashboard failure" }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/dashboard?mode=seller");
  await expect(page.getByRole("alert")).toContainText(
    "Temporary dashboard failure",
  );
  await page.getByRole("button", { name: "Retry seller dashboard" }).click();
  await expect(page.getByRole("button", { name: "Products" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("buyer and seller workspaces fit a narrow mobile viewport without horizontal overflow", async ({
  page,
}, testInfo) => {
  await login(page, "seller.local@example.test");
  const widths = [320, 375, 768, 1024, 1440];
  await page.goto("/dashboard?mode=buyer");
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await testInfo.attach("buyer-dashboard-desktop", {
    body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await testInfo.attach("buyer-dashboard-mobile", {
    body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    contentType: "image/png",
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    if (width <= 720) {
      await page
        .locator("#buyer-dashboard-section-jump")
        .selectOption("orders");
    } else {
      const ordersButton = page.getByRole("button", {
        name: "Orders",
        exact: true,
      });
      await ordersButton.focus();
      await expect(ordersButton).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(/\/dashboard\?tab=orders$/);
  }

  await page.getByRole("button", { name: "Seller view" }).click();
  await expect(
    page.getByRole("heading", { name: "Seller dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Seller account summary" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await testInfo.attach("seller-dashboard-desktop", {
    body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await testInfo.attach("seller-dashboard-mobile", {
    body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    contentType: "image/png",
  });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    if (width <= 720) {
      await page
        .locator("#seller-dashboard-section-jump")
        .selectOption("products");
    } else {
      const productsButton = page
        .getByRole("group", { name: "Catalog" })
        .getByRole("button", { name: "Products" });
      await productsButton.focus();
      await expect(productsButton).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(page).toHaveURL(/\/dashboard\?mode=seller&tab=products$/);
  }
});

test("member homepage cart summary refreshes with the shared cart-change event", async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `dashboard-cart-${suffix}@example.test`;
  const registered = await page.request.post("/api/auth/register", {
    data: { email, name: "Dashboard Cart Test Member", password },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const registeredUser = ((await registered.json()) as { user: { id: string } })
    .user;
  await prisma.user.update({
    where: { id: registeredUser.id },
    data: { onboardingCompletedAt: new Date() },
  });
  const productsResponse = await page.request.get("/api/products");
  expect(productsResponse.ok(), await productsResponse.text()).toBeTruthy();
  const products = (
    (await productsResponse.json()) as {
      items: { id: string; name: string; availableStock: number }[];
    }
  ).items;
  const product = products.find(
    (item) => item.name === "Demo Canvas Tote" && item.availableStock > 1,
  );
  expect(
    product,
    "the disposable seed should include the approved USD demo tote",
  ).toBeTruthy();
  const cartResponse = await page.request.get("/api/cart");
  expect(cartResponse.ok(), await cartResponse.text()).toBeTruthy();
  const cartBefore = (await cartResponse.json()) as {
    items: { quantity: number }[];
  };
  expect(
    cartBefore.items,
    "the newly registered test buyer should have an isolated empty cart",
  ).toHaveLength(0);
  const expectedCount =
    cartBefore.items.reduce((sum, item) => sum + item.quantity, 0) + 1;

  await page.goto("/");
  const productCard = page.locator("article.productCard").filter({
    has: page.getByRole("heading", { name: product!.name, exact: true }),
  });
  await productCard.getByRole("button", { name: "Add to cart" }).click();
  await expect(
    page.getByRole("link", { name: `In your cart: ${expectedCount} items` }),
  ).toBeVisible();
  await expect(page.locator(".cartButton b")).toHaveText(String(expectedCount));
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  const removed = await page.request.patch(`/api/cart/items/${product!.id}`, {
    data: { quantity: 0 },
    headers: { "x-csrf-token": csrf! },
  });
  expect(removed.status(), await removed.text()).toBe(204);
});

test("header and buyer dashboard cart counts stay in sync across navigation and another tab", async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `dashboard-cart-sync-${suffix}@example.test`;
  const registered = await page.request.post("/api/auth/register", {
    data: { email, name: "Dashboard Cart Sync Test", password },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const registeredUser = ((await registered.json()) as { user: { id: string } })
    .user;
  await prisma.user.update({
    where: { id: registeredUser.id },
    data: { onboardingCompletedAt: new Date() },
  });

  const productsResponse = await page.request.get("/api/products");
  expect(productsResponse.ok(), await productsResponse.text()).toBeTruthy();
  const products = (
    (await productsResponse.json()) as {
      items: { id: string; name: string; availableStock: number }[];
    }
  ).items;
  const product = products.find(
    (item) => item.name === "Demo Canvas Tote" && item.availableStock > 1,
  );
  expect(
    product,
    "the disposable seed should include the approved USD demo tote",
  ).toBeTruthy();

  await page.goto("/");
  const productCard = page.locator("article.productCard").filter({
    has: page.getByRole("heading", { name: product!.name, exact: true }),
  });
  await productCard.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator(".cartButton b")).toHaveText("1");

  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  await expect(cartSummaryValue(page)).toHaveText("1");
  await expect(page.locator(".cartButton b")).toHaveText("1");

  const secondTab = await page.context().newPage();
  try {
    await secondTab.goto("/dashboard?tab=cart");
    await expect(
      secondTab.getByRole("heading", { name: "Buyer dashboard" }),
    ).toBeVisible();
    await secondTab
      .getByRole("button", { name: "Increase Demo Canvas Tote" })
      .click();
    await expect(secondTab.locator(".cartButton b")).toHaveText("2");

    await page.bringToFront();
    await expect(page.locator(".cartButton b")).toHaveText("2");
    await expect(cartSummaryValue(page)).toHaveText("2");

    await secondTab.bringToFront();
    await secondTab
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(secondTab.locator(".cartButton b")).toHaveText("0");

    await page.bringToFront();
    await expect(page.locator(".cartButton b")).toHaveText("0");
    await expect(cartSummaryValue(page)).toHaveText("0");
  } finally {
    await secondTab.close();
  }
});

test("admin remains on the separate admin surface and cannot use a buyer/seller dashboard switch", async ({
  page,
}) => {
  await login(page, "admin.local@example.test");
  const access = await page.request.get("/api/dashboard/access");
  expect(access.ok()).toBeTruthy();
  expect((await access.json()).buyer).toBe(false);
  await expect((await page.request.get("/api/dashboard/buyer")).status()).toBe(
    403,
  );
  await expect((await page.request.get("/api/dashboard/seller")).status()).toBe(
    403,
  );
});
