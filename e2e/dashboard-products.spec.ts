import { expect, test } from "@playwright/test";

const password = "LocalDemoOnly-ChangeMe-123!";
const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAAB5ErkJggg==",
  "base64",
);

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

  const productName = "Dashboard extraction test listing";
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
  await expect(
    page.getByRole("button", { name: "Create listing" }),
  ).toBeEnabled();

  const productCreated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/products") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create listing" }).click();
  const createResponse = await productCreated;
  expect(createResponse.status(), await createResponse.text()).toBe(201);

  await expect(
    page.getByText(
      "Listing created and sent through the configured product review policy.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
});
