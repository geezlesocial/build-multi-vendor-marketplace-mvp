import { expect, test } from "@playwright/test";
import { ProductStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const password = "LocalDemoOnly-ChangeMe-123!";
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "E2E_DATABASE_URL is required; live-session browser tests use the guarded disposable E2E database.",
  );
}
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);
const fixtureProductIds: string[] = [];
const fixtureSessionIds: string[] = [];

test.afterAll(async () => {
  if (fixtureSessionIds.length) {
    await prisma.liveSession.deleteMany({
      where: { id: { in: fixtureSessionIds } },
    });
  }
  if (fixtureProductIds.length) {
    await prisma.inventory.deleteMany({
      where: { productId: { in: fixtureProductIds } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: fixtureProductIds } },
    });
  }
  await prisma.$disconnect();
});

test("seller live-session routes preserve list, edit, soft-delete, and restore behavior", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "seller.local@example.test", password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  );
  expect(csrf).toBeTruthy();
  const headers = { "x-csrf-token": csrf!.value };
  const sellerUser = await prisma.user.findUniqueOrThrow({
    where: { email: "seller.local@example.test" },
    select: { id: true },
  });
  const seller = await prisma.seller.findUniqueOrThrow({
    where: { userId: sellerUser.id },
    select: { id: true },
  });
  const productType = await prisma.catalogProductType.findUniqueOrThrow({
    where: { slug: "physical-product" },
    select: { id: true },
  });
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      productTypeId: productType.id,
      name: `Live session route fixture ${randomUUID()}`,
      slug: `live-session-route-${randomUUID()}`,
      description: "Disposable approved product for live-session route tests.",
      priceMinor: 1200,
      status: ProductStatus.APPROVED,
      inventory: { create: { quantity: 1 } },
    },
    select: { id: true },
  });
  fixtureProductIds.push(product.id);

  const createdResponse = await page.request.post("/api/seller/live-sessions", {
    headers,
    data: {
      title: "Route extraction lifecycle test",
      timezone: "UTC",
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      productIds: [product.id],
    },
  });
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = (await createdResponse.json()) as {
    id: string;
    title: string;
    status: string;
  };
  fixtureSessionIds.push(created.id);
  expect(created).toMatchObject({
    title: "Route extraction lifecycle test",
    status: "SCHEDULED",
  });

  const activeResponse = await page.request.get(
    "/api/seller/live-sessions?view=active",
  );
  expect(activeResponse.ok(), await activeResponse.text()).toBeTruthy();
  expect(
    ((await activeResponse.json()) as { id: string }[]).some(
      (session) => session.id === created.id,
    ),
  ).toBe(true);

  const blockedStart = await page.request.post(
    `/api/seller/live-sessions/${created.id}/transition`,
    { headers, data: { status: "STARTING" } },
  );
  expect(blockedStart.status()).toBe(409);
  expect(await blockedStart.json()).toMatchObject({
    error: "Deployment gate LIVE_SHOPPING_AVAILABLE is false.",
    liveShopping: { deploymentGate: false, effectiveEnabled: false },
  });

  const updateResponse = await page.request.patch(
    `/api/seller/live-sessions/${created.id}`,
    {
      headers,
      data: { title: "Updated route extraction lifecycle test" },
    },
  );
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  expect(await updateResponse.json()).toMatchObject({
    id: created.id,
    title: "Updated route extraction lifecycle test",
    status: "SCHEDULED",
  });

  const invalidView = await page.request.get(
    "/api/seller/live-sessions?view=all",
  );
  expect(invalidView.status()).toBe(400);

  const deleted = await page.request.delete(
    `/api/seller/live-sessions/${created.id}`,
    { headers },
  );
  expect(deleted.status()).toBe(204);
  const deletedResponse = await page.request.get(
    "/api/seller/live-sessions?view=deleted",
  );
  expect(deletedResponse.ok(), await deletedResponse.text()).toBeTruthy();
  expect(
    ((await deletedResponse.json()) as { id: string }[]).some(
      (session) => session.id === created.id,
    ),
  ).toBe(true);

  const restored = await page.request.post(
    `/api/seller/live-sessions/${created.id}/restore`,
    { headers },
  );
  expect(restored.ok(), await restored.text()).toBeTruthy();
  expect(await restored.json()).toMatchObject({
    id: created.id,
    title: "Updated route extraction lifecycle test",
    status: "DRAFT",
  });
  const activeAfterRestore = await page.request.get(
    "/api/seller/live-sessions?view=active",
  );
  expect(activeAfterRestore.ok(), await activeAfterRestore.text()).toBeTruthy();
  expect(
    ((await activeAfterRestore.json()) as { id: string }[]).some(
      (session) => session.id === created.id,
    ),
  ).toBe(true);
});

test("seller live-session list and create routes reject guests and buyers", async ({
  page,
}) => {
  const guestList = await page.request.get("/api/seller/live-sessions");
  expect(guestList.status()).toBe(401);

  const login = await page.request.post("/api/auth/login", {
    data: { email: "buyer.local@example.test", password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "marketplace_csrf",
  );
  expect(csrf).toBeTruthy();

  const buyerList = await page.request.get("/api/seller/live-sessions");
  expect(buyerList.status()).toBe(403);
  const buyerCreate = await page.request.post("/api/seller/live-sessions", {
    headers: { "x-csrf-token": csrf!.value },
    data: { title: "Unauthorized live show", timezone: "UTC", productIds: [] },
  });
  expect(buyerCreate.status()).toBe(403);
});
