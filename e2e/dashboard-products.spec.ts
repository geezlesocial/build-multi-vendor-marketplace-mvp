import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error("E2E_DATABASE_URL is required for product dashboard tests.");
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

const password = "LocalDemoOnly-ChangeMe-123!";
const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAAB5ErkJggg==",
  "base64",
);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("seller can create a product from the isolated product workspace", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "seller.local@example.test", password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();

  await page.goto("/dashboard?mode=seller&tab=products");
  await expect(
    page.getByRole("heading", { name: "Create a product" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Product media library" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your listings" }),
  ).toBeVisible();

  const mp4Header = Buffer.alloc(32);
  mp4Header.writeUInt32BE(mp4Header.length, 0);
  mp4Header.write("ftyp", 4, "ascii");
  mp4Header.write("isom", 8, "ascii");
  await page.getByLabel("Choose images, video, or documents").setInputFiles([
    { name: "product-gallery.png", mimeType: "image/png", buffer: samplePng },
    { name: "product-intro.mp4", mimeType: "video/mp4", buffer: mp4Header },
  ]);
  const uploadRows = page.locator(".sellerUploadRow");
  await expect(
    uploadRows
      .filter({ hasText: "product-gallery.png" })
      .getByText("Awaiting scan", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    uploadRows
      .filter({ hasText: "product-intro.mp4" })
      .getByText("Awaiting scan", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const suffix = randomUUID();
  const productName = `Dashboard color variant listing ${suffix.slice(0, 8)}`;
  const createListing = page.getByRole("region", { name: "Create a product" });
  await createListing.getByLabel("Product name").fill(productName);
  await createListing
    .getByLabel("Description", { exact: true })
    .fill("Synthetic listing created by the dashboard browser test.");
  await createListing.getByLabel(/Regular price/).fill("2450");
  await createListing.getByLabel("Available stock").fill("3");
  await createListing
    .getByRole("combobox", { name: "Search Category" })
    .fill("Featured");
  await createListing
    .getByRole("option", { name: "Featured", exact: true })
    .click();

  const variantSkus = [
    `COLOR-${suffix.slice(0, 8)}-OCEAN`,
    `COLOR-${suffix.slice(0, 8)}-CHARCOAL`,
  ];
  const colorSearch = createListing.getByLabel("Search or enter a color");
  await colorSearch.fill("Ocean Blue");
  await colorSearch.press("Enter");
  const oceanRow = createListing
    .locator(".sellerColorVariantRow")
    .filter({ hasText: "Color 1: Ocean Blue" });
  await oceanRow.getByLabel("SKU").fill(variantSkus[0]!);
  await oceanRow.getByLabel("Price (minor units)").fill("1999");
  await oceanRow.getByLabel("Available stock").fill("24");

  await createListing.getByLabel("Search or enter a color").fill("Charcoal");
  await createListing.getByRole("button", { name: "Add color" }).click();
  const charcoalRow = createListing
    .locator(".sellerColorVariantRow")
    .filter({ hasText: "Color 2: Charcoal" });
  await charcoalRow.getByLabel("SKU").fill(variantSkus[1]!);
  await charcoalRow.getByLabel("Price (minor units)").fill("2450");
  await charcoalRow.getByLabel("Available stock").fill("5");

  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const variantSection = createListing.locator(".sellerColorVariants");
    const dimensions = await variantSection.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(
      dimensions.clientWidth + 1,
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(
    page.getByRole("button", { name: "Create listing" }),
  ).toBeEnabled();

  let simulateLostResponse = true;
  await page.route("**/api/products/*/variants", async (route) => {
    if (route.request().method() !== "POST" || !simulateLostResponse) {
      await route.continue();
      return;
    }
    simulateLostResponse = false;
    const savedResponse = await route.fetch();
    await route.fulfill({
      response: savedResponse,
      status: 503,
      body: JSON.stringify({
        error: "Simulated response loss after the variant was saved.",
      }),
    });
  });

  const productCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/products") &&
      response.request().method() === "POST",
  );
  const variantResponseStatuses: number[] = [];
  const collectVariantResponses = (
    response: import("@playwright/test").Response,
  ) => {
    if (
      response.url().includes("/variants") &&
      response.request().method() === "POST"
    )
      variantResponseStatuses.push(response.status());
  };
  page.on("response", collectVariantResponses);
  await page.getByRole("button", { name: "Create listing" }).click();
  const createResponse = await productCreated;
  const product = (await createResponse.json()) as { id: string };
  expect(createResponse.status()).toBe(201);
  await expect.poll(() => variantResponseStatuses.length).toBe(2);
  expect(variantResponseStatuses).toEqual([503, 201]);
  await expect(
    page.getByRole("button", { name: "Retry unsaved color options" }),
  ).toBeVisible();
  await expect(oceanRow).toContainText("Needs retry");
  await expect(charcoalRow).toContainText("Saved");

  expect(
    await prisma.productVariant.count({ where: { productId: product.id } }),
  ).toBe(2);
  await page
    .getByRole("button", { name: "Retry unsaved color options" })
    .click();
  await expect(
    page.getByText(
      "Listing and all color options saved through the configured product review policy.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await prisma.productVariant.count({ where: { productId: product.id } }),
  ).toBe(2);
  const savedVariants = await prisma.productVariant.findMany({
    where: { productId: product.id },
    orderBy: { name: "asc" },
  });
  expect(savedVariants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Charcoal",
        priceMinor: 2450,
        stock: 5,
        mediaAssetId: null,
      }),
      expect.objectContaining({
        name: "Ocean Blue",
        priceMinor: 1999,
        stock: 24,
        mediaAssetId: null,
      }),
    ]),
  );

  const productEditor = page
    .locator(".productEditor")
    .filter({ hasText: productName });
  const variantManager = productEditor.locator(".sellerVariantManager");
  const oceanVariantRow = variantManager
    .locator(".sellerVariantList li")
    .filter({ hasText: "Ocean Blue" });
  await oceanVariantRow.getByRole("button", { name: "Edit" }).click();
  await variantManager.getByLabel("Price (minor units)").fill("2100");
  const variantUpdated = page.waitForResponse(
    (response) =>
      response.url().includes("/variants/") &&
      response.request().method() === "PATCH",
  );
  await variantManager
    .getByRole("button", { name: "Save color option" })
    .click();
  expect((await variantUpdated).status()).toBe(200);
  await expect(
    variantManager
      .locator(".sellerVariantList li")
      .filter({ hasText: "Ocean Blue" }),
  ).toContainText("2100");
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
});
