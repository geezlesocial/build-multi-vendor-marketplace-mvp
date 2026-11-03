import { expect, test, type Page } from "@playwright/test";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "E2E_DATABASE_URL is required for checkout preservation tests.",
  );
}
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

const buyerEmail = "buyer.local@example.test";
const password = "LocalDemoOnly-ChangeMe-123!";

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { email: buyerEmail, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  return { "x-csrf-token": csrf! };
}

test("a rejected checkout preserves the cart and creates no order", async ({
  page,
}) => {
  await login(page);
  const headers = await csrfHeaders(page);
  const buyer = await prisma.user.findUniqueOrThrow({
    where: { email: buyerEmail },
    select: { id: true },
  });

  const catalogResponse = await page.request.get(
    "/api/products?q=Demo%20Canvas%20Tote",
  );
  expect(catalogResponse.ok(), await catalogResponse.text()).toBeTruthy();
  const catalog = (await catalogResponse.json()) as {
    items: { id: string }[];
  };
  const product = catalog.items[0];
  expect(product).toBeTruthy();

  const currency = await prisma.currencyCatalogEntry.findUniqueOrThrow({
    where: { code: "USD" },
    select: { checkoutEnabled: true },
  });

  await prisma.cartItem.deleteMany({ where: { cart: { userId: buyer.id } } });
  try {
    const addResponse = await page.request.post("/api/cart/items", {
      data: { productId: product!.id, quantity: 1 },
      headers,
    });
    expect(addResponse.status(), await addResponse.text()).toBe(201);

    const cartBeforeResponse = await page.request.get("/api/cart");
    expect(
      cartBeforeResponse.ok(),
      await cartBeforeResponse.text(),
    ).toBeTruthy();
    const cartBefore = (await cartBeforeResponse.json()) as {
      items: { productId: string; quantity: number }[];
    };
    const cartSnapshot = cartBefore.items.map(({ productId, quantity }) => ({
      productId,
      quantity,
    }));
    expect(cartSnapshot).toEqual([{ productId: product!.id, quantity: 1 }]);

    const ordersBefore = await prisma.parentOrder.count({
      where: { buyerId: buyer.id },
    });
    await prisma.currencyCatalogEntry.update({
      where: { code: "USD" },
      data: { checkoutEnabled: false },
    });

    const checkoutResponse = await page.request.post("/api/orders/checkout", {
      data: {
        buyerEmail,
        buyerName: "Local Buyer",
        address: {
          line1: "1 Test Street",
          city: "Test City",
          region: "TS",
          postalCode: "1000",
          country: "US",
        },
        method: "COD",
      },
      headers,
    });
    expect(checkoutResponse.status()).toBe(409);
    expect(await checkoutResponse.json()).toMatchObject({
      code: "CHECKOUT_CURRENCY_UNAVAILABLE",
    });

    const cartAfterResponse = await page.request.get("/api/cart");
    expect(cartAfterResponse.ok(), await cartAfterResponse.text()).toBeTruthy();
    const cartAfter = (await cartAfterResponse.json()) as {
      items: { productId: string; quantity: number }[];
    };
    expect(
      cartAfter.items.map(({ productId, quantity }) => ({
        productId,
        quantity,
      })),
    ).toEqual(cartSnapshot);
    expect(
      await prisma.parentOrder.count({ where: { buyerId: buyer.id } }),
    ).toBe(ordersBefore);
  } finally {
    await prisma.currencyCatalogEntry.update({
      where: { code: "USD" },
      data: { checkoutEnabled: currency.checkoutEnabled },
    });
    await prisma.cartItem.deleteMany({ where: { cart: { userId: buyer.id } } });
  }
});
