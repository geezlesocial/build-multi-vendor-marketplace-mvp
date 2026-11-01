import { expect, test } from "@playwright/test";

const password = "LocalDemoOnly-ChangeMe-123!";

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

  const productName = "Dashboard extraction test listing";
  const createListing = page.getByRole("region", { name: "Create a product" });
  await createListing.getByLabel("Product name").fill(productName);
  await createListing
    .getByLabel("Description", { exact: true })
    .fill("Synthetic listing created by the dashboard browser test.");
  await createListing.getByLabel(/Regular price/).fill("2450");
  await createListing.getByLabel("Available stock").fill("3");
  await createListing
    .getByRole("combobox", { name: /^Category/ })
    .selectOption({ label: "Featured" });
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
