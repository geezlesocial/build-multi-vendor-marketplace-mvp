import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error("E2E_DATABASE_URL is required for variant checkout tests.");
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("selected color stays attached to cart and checkout order snapshots", async ({
  page,
}) => {
  const suffix = randomUUID();
  const sellerTemplate = await prisma.product.findUniqueOrThrow({
    where: { slug: "demo-canvas-tote" },
    select: {
      sellerId: true,
      seller: { select: { store: { select: { name: true } } } },
    },
  });
  expect(sellerTemplate.sellerId).toBeTruthy();
  const product = await prisma.product.create({
    data: {
      seller: { connect: { id: sellerTemplate.sellerId! } },
      productType: { connect: { slug: "physical-product" } },
      name: `Color Checkout ${suffix.slice(0, 8)}`,
      slug: `color-checkout-${suffix}`,
      description: "Synthetic physical listing for color checkout coverage.",
      priceMinor: 2499,
      status: "APPROVED",
      inventory: { create: { quantity: 8 } },
    },
    select: { id: true, name: true },
  });
  const variantName = `Ocean Blue ${suffix.slice(0, 4)}`;
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      name: variantName,
      sku: `E2E-COLOR-${suffix}`,
      priceMinor: 1999,
      currency: "USD",
      stock: 4,
      status: "APPROVED",
    },
  });
  const buyerEmail = `variant-checkout-${suffix}@example.test`;
  const registration = await page.request.post("/api/auth/register", {
    data: {
      name: "Color Variant Checkout Buyer",
      email: buyerEmail,
      password: "LocalDemoOnly-ChangeMe-123!",
    },
  });
  const registrationBody = (await registration.json()) as {
    user: { id: string };
  };
  expect(registration.status()).toBe(201);
  const { user } = registrationBody;
  await prisma.user.update({
    where: { id: user.id },
    data: { onboardingCompletedAt: new Date() },
  });
  const login = await page.request.post("/api/auth/login", {
    data: { email: buyerEmail, password: "LocalDemoOnly-ChangeMe-123!" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const session = await page.request.get("/api/auth/me");
  expect(session.ok(), await session.text()).toBeTruthy();
  expect(await session.json()).toMatchObject({ user: { id: user.id } });

  await page.goto(`/products/${product.id}`);
  const oceanBlue = page.getByRole("radio", {
    name: `${variantName}, 4 available`,
  });
  await oceanBlue.focus();
  await page.keyboard.press("Space");
  await expect(oceanBlue).toBeChecked();
  await expect(page.locator(".productPrice")).toContainText("19.99");
  const addToCart = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/cart/items") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add to cart" }).click();
  const addResponse = await addToCart;
  expect(addResponse.status(), await addResponse.text()).toBe(201);
  await expect(page.getByText("Added to cart.", { exact: true })).toBeVisible();

  const cartResponse = await page.request.get("/api/cart");
  expect(cartResponse.ok(), await cartResponse.text()).toBeTruthy();
  const cart = (await cartResponse.json()) as {
    items: {
      productId: string;
      variant?: { id: string; name: string };
      quantity: number;
    }[];
  };
  expect(cart.items).toEqual([
    expect.objectContaining({
      productId: product.id,
      quantity: 1,
      variant: expect.objectContaining({ id: variant.id, name: variantName }),
    }),
  ]);

  await page.getByRole("link", { name: /Cart/ }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator(".cartLine")).toContainText(
    `${product.name} — ${variantName}`,
  );
  await page
    .getByLabel("Name", { exact: true })
    .fill("Color Variant Checkout Buyer");
  await page.getByLabel("Email", { exact: true }).fill(buyerEmail);
  await page.getByLabel("Address", { exact: true }).fill("1 Test Street");
  await page.getByLabel("City", { exact: true }).fill("Test City");
  await page.getByLabel("Region", { exact: true }).fill("TS");
  await page.getByLabel("Postal code", { exact: true }).fill("1000");
  await page.getByLabel("Country code", { exact: true }).fill("US");
  await page.getByRole("button", { name: "Calculate shipping" }).click();
  await expect(
    page.getByRole("combobox", {
      name: `Delivery service for ${sellerTemplate.seller?.store?.name}`,
    }),
  ).toHaveValue("local-demo-shipping-service");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".orderConfirmation")).toContainText(
    "Order confirmed",
  );

  const order = await prisma.parentOrder.findFirstOrThrow({
    where: { buyerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { sellerOrders: { include: { items: true } } },
  });
  expect(
    order.sellerOrders.flatMap((sellerOrder) => sellerOrder.items),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        productId: product.id,
        variantId: variant.id,
        variantName,
        unitPriceMinor: 1999,
      }),
    ]),
  );
});
