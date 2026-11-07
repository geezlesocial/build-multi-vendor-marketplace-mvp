import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";

const password = "LocalDemoOnly-ChangeMe-123!";
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required for buyer order browser tests.",
  );
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

test("buyer order history renders typed seller and shipment details", async ({
  page,
}) => {
  const buyer = await prisma.user.findUniqueOrThrow({
    where: { email: "buyer.local@example.test" },
    select: { id: true, email: true, name: true },
  });
  const sellerUser = await prisma.user.findUniqueOrThrow({
    where: { email: "seller.local@example.test" },
    select: { id: true },
  });
  const seller = await prisma.seller.findUniqueOrThrow({
    where: { userId: sellerUser.id },
    select: { id: true },
  });
  const product = await prisma.product.findFirstOrThrow({
    where: { sellerId: seller.id },
    select: { id: true, name: true, priceMinor: true },
  });
  const carrier = "PR105 Local Courier";
  const trackingNumber = `PR105-${randomUUID()}`;
  const trackingUrl = `https://tracking.example.test/${trackingNumber}`;
  const shipmentNote = "Parcel scanned at the local sorting facility.";
  const shippedAt = new Date();
  const orderNumber = `PR105-${randomUUID()}`;
  const totalMinor = product.priceMinor * 2;

  await prisma.parentOrder.create({
    data: {
      orderNumber,
      buyerId: buyer.id,
      buyerEmail: buyer.email,
      buyerName: buyer.name,
      addressJson: {
        line1: "1 Test Street",
        city: "Test City",
        region: "TS",
        postalCode: "1000",
        country: "US",
      },
      totalMinor,
      currency: "USD",
      status: "CONFIRMED",
      payment: { create: { method: "PAYPAL", status: "PENDING" } },
      sellerOrders: {
        create: {
          sellerId: seller.id,
          status: "PROCESSING",
          totalMinor,
          shipmentStatus: "IN_TRANSIT",
          shippingCarrier: carrier,
          trackingNumber,
          trackingUrl,
          shippedAt,
          items: {
            create: {
              productId: product.id,
              productName: product.name,
              unitPriceMinor: product.priceMinor,
              quantity: 2,
              currencySnapshot: "USD",
            },
          },
          shipmentUpdates: {
            create: {
              status: "IN_TRANSIT",
              carrier,
              trackingNumber,
              trackingUrl,
              note: shipmentNote,
              createdById: sellerUser.id,
            },
          },
        },
      },
    },
  });

  await login(page, buyer.email);
  await page.goto("/dashboard?tab=orders");

  const order = page
    .locator(".buyerOrderCard")
    .filter({ hasText: orderNumber });
  await expect(order).toBeVisible();
  await order.locator(":scope > summary").click();
  await expect(order).toContainText("Confirmed");
  await expect(order).toContainText("PAYPAL");
  await expect(order).toContainText("Payment status: Pending");
  await expect(order).toContainText("Demo Store");
  await expect(order).toContainText("In transit");
  await expect(order).toContainText(product.name);
  await expect(order.locator(".trackingDetails")).toContainText(carrier);
  await expect(order.locator(".trackingDetails")).toContainText(trackingNumber);
  await expect(
    order.getByRole("link", { name: "Track with carrier" }),
  ).toHaveAttribute("href", trackingUrl);
  await expect(
    order.getByRole("list", { name: "Shipment progress" }),
  ).toContainText(shipmentNote);
  await expect(
    order.getByRole("button", { name: "Confirm item received" }),
  ).toBeVisible();
});
