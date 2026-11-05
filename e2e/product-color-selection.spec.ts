import { expect, test } from "@playwright/test";

const productFixture = {
  id: "color-variant-fixture",
  name: "Color preview bottle",
  slug: "color-preview-bottle",
  description: "A product used to check color selection and gallery behavior.",
  priceMinor: 1299,
  salePriceMinor: null,
  currency: "USD",
  availableStock: 12,
  color: null,
  category: null,
  brand: null,
  features: [],
  images: [
    {
      id: "default-image",
      url: "/fixture/general-product.jpg",
      alt: "General bottle image",
    },
  ],
  mediaAttachments: [],
  variants: [
    {
      id: "variant-blue",
      name: "Blue",
      priceMinor: 1299,
      currency: "USD",
      stock: 7,
      image: null,
    },
    {
      id: "variant-ocean",
      name: "Ocean Blue",
      priceMinor: 1999,
      currency: "USD",
      stock: 5,
      image: null,
    },
    {
      id: "variant-red",
      name: "Red",
      priceMinor: 1499,
      currency: "USD",
      stock: 3,
      image: { id: "red-image", url: "/fixture/red-product.jpg" },
    },
  ],
  wholesaleEnabled: false,
  wholesaleMinQuantity: null,
  wholesaleMaxQuantity: null,
  seller: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/products/color-variant-fixture", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(productFixture),
    }),
  );
  await page.route("**/api/products/color-variant-fixture/reviews", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        averageRating: null,
        reviewCount: 0,
        canReview: false,
        reason: "",
        existingReview: null,
        items: [],
      }),
    }),
  );
  await page.route("**/api/store-buster/signals", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route("**/api/ai/recommendations?placement=product", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], personalized: false, disabled: true }),
    }),
  );
  await page.route("**/fixture/*.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#dce8e8"/></svg>',
    }),
  );
});

test("buyers can keyboard-select a color, see its exact image, and fall back to the general image", async ({
  page,
}) => {
  await page.goto("/products/color-variant-fixture");
  await expect(
    page.getByRole("heading", { name: productFixture.name }),
  ).toBeVisible();

  const gallery = page.getByRole("region", {
    name: `${productFixture.name} media gallery`,
  });
  const galleryImage = gallery.locator(".productMediaGalleryStage img");
  await expect(galleryImage).toHaveAttribute(
    "src",
    "/fixture/general-product.jpg",
  );

  const blue = page.getByRole("radio", { name: "Blue, 7 available" });
  const ocean = page.getByRole("radio", { name: "Ocean Blue, 5 available" });
  const red = page.getByRole("radio", { name: "Red, 3 available" });
  await blue.focus();
  await page.keyboard.press("Space");
  await expect(blue).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(ocean).toBeChecked();
  await expect(page.getByText("Selected option: Ocean Blue")).toBeVisible();
  await expect(page.locator(".productPrice")).toContainText("19.99");
  await expect(galleryImage).toHaveAttribute(
    "src",
    "/fixture/general-product.jpg",
  );

  await page.keyboard.press("ArrowRight");
  await expect(red).toBeChecked();
  await expect(page.locator(".productPrice")).toContainText("14.99");
  await expect(galleryImage).toHaveAttribute("src", "/fixture/red-product.jpg");

  await page.getByText("Choose from a list instead").click();
  await page
    .getByRole("combobox", {
      name: "Choose a color or option for Color preview bottle",
    })
    .selectOption("variant-ocean");
  await expect(ocean).toBeChecked();
  await expect(galleryImage).toHaveAttribute(
    "src",
    "/fixture/general-product.jpg",
  );
});

test("color choices remain visible and within the layout at supported viewport widths", async ({
  page,
}) => {
  await page.goto("/products/color-variant-fixture");
  const fieldset = page.locator(".productVariantSwatches");
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(fieldset).toBeVisible();
    const layout = await fieldset.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const radios = [
        ...element.querySelectorAll<HTMLElement>(".productVariantSwatch"),
      ].map((item) => item.getBoundingClientRect());
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: bounds.left,
        right: bounds.right,
        radioBounds: radios.map((item) => ({
          left: item.left,
          right: item.right,
        })),
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(
      layout.radioBounds.every(
        (item) =>
          item.left >= layout.left - 1 && item.right <= layout.right + 1,
      ),
    ).toBe(true);
  }
});
