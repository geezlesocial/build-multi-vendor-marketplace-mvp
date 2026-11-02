import { expect, test } from "@playwright/test";
import { Role, SellerStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required; future FX rate tests require the guarded disposable database.",
  );
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("future-dated FX snapshots do not hide a current rate from storefronts or marketplace display options", async ({
  page,
}) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const sellerTemplate = await prisma.user.findUniqueOrThrow({
    where: { email: "seller.local@example.test" },
    select: { passwordHash: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `future-fx-${suffix}@example.test`,
      name: `Future FX ${suffix}`,
      role: Role.SELLER,
      passwordHash: sellerTemplate.passwordHash,
      onboardingCompletedAt: new Date(),
    },
  });
  const seller = await prisma.seller.create({
    data: { userId: user.id, status: SellerStatus.APPROVED },
  });
  const store = await prisma.store.create({
    data: {
      sellerId: seller.id,
      name: `Future FX Store ${suffix}`,
      slug: `future-fx-store-${suffix}`,
    },
  });
  await prisma.storeCurrencyOffer.createMany({
    data: [
      {
        storeId: store.id,
        currency: "USD",
        displayEnabled: true,
        checkoutEnabled: true,
      },
      {
        storeId: store.id,
        currency: "JPY",
        displayEnabled: true,
        checkoutEnabled: false,
      },
    ],
  });

  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const tomorrowUtc = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);
  await prisma.exchangeRateSnapshot.createMany({
    data: [
      {
        baseCurrency: "USD",
        quoteCurrency: "JPY",
        rate: "150",
        provider: `e2e-current-${suffix}`,
        sourceDate: todayUtc,
        fetchedAt: now,
      },
      {
        baseCurrency: "USD",
        quoteCurrency: "JPY",
        rate: "999",
        provider: `e2e-future-${suffix}`,
        sourceDate: tomorrowUtc,
        fetchedAt: now,
      },
    ],
  });

  const loginResponse = await page.request.post("/api/auth/login", {
    data: {
      email: "buyer.local@example.test",
      password: "LocalDemoOnly-ChangeMe-123!",
    },
  });
  expect(loginResponse.ok(), await loginResponse.text()).toBeTruthy();
  const globalOptionsResponse = await page.request.get(
    "/api/currency/cart-options",
  );
  expect(
    globalOptionsResponse.ok(),
    await globalOptionsResponse.text(),
  ).toBeTruthy();
  const globalOptions = (await globalOptionsResponse.json()) as {
    displayCurrencies: { code: string }[];
  };
  expect(
    globalOptions.displayCurrencies.map((currency) => currency.code),
  ).toContain("JPY");

  const storeOptionsResponse = await page.request.get(
    `/api/stores/${store.slug}/currencies`,
  );
  expect(
    storeOptionsResponse.ok(),
    await storeOptionsResponse.text(),
  ).toBeTruthy();
  const storeOptions = (await storeOptionsResponse.json()) as {
    currencies: { code: string; displayAvailable: boolean }[];
  };
  expect(
    storeOptions.currencies.find((currency) => currency.code === "JPY")
      ?.displayAvailable,
  ).toBe(true);

  await page.goto(`/store/${store.slug}`);
  const displayCurrency = page.getByLabel("Store display currency");
  await expect(displayCurrency.locator('option[value="JPY"]')).toHaveCount(1);
  await displayCurrency.selectOption("JPY");
  await expect(displayCurrency).toHaveValue("JPY");
});
