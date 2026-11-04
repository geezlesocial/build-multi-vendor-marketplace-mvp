import { expect, test, type Page } from "@playwright/test";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";
import { seedCatalogDefaults } from "../apps/api/prisma/catalog-defaults.js";

const password = "LocalDemoOnly-ChangeMe-123!";
const adminEmail = "admin.local@example.test";
const buyerEmail = "buyer.local@example.test";
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "E2E_DATABASE_URL is required; catalog tests must use the guarded disposable database.",
  );
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(
    (cookie) => cookie.name === "marketplace_csrf",
  )?.value;
  expect(csrf).toBeTruthy();
  return { "x-csrf-token": csrf! };
}

test.afterAll(async () => prisma.$disconnect());

test("admin catalog defaults, edit safety, responsive dialog, taxonomy limits, and slug redirects", async ({
  page,
}) => {
  await login(page, adminEmail);
  const [categoriesResponse, brandsResponse] = await Promise.all([
    page.request.get("/api/admin/categories"),
    page.request.get("/api/admin/brands"),
  ]);
  expect(categoriesResponse.ok(), await categoriesResponse.text()).toBeTruthy();
  expect(brandsResponse.ok(), await brandsResponse.text()).toBeTruthy();
  const categories = (await categoriesResponse.json()) as Array<{
    id: string;
    name: string;
    parentId: string | null;
    slug: string;
  }>;
  const brands = (await brandsResponse.json()) as Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  expect(
    categories.some((category) => category.name === "Electronics & Technology"),
  ).toBe(true);
  expect(brands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Apple", slug: "apple" }),
      expect.objectContaining({ name: "Nestlé", slug: "nestle" }),
      expect.objectContaining({ name: "L’Oréal Paris", slug: "loreal-paris" }),
    ]),
  );
  const google = brands.find(
    (brand) => brand.id === "catalog-default-brand-google",
  );
  expect(google).toBeDefined();
  expect(await prisma.product.count({ where: { brandId: google!.id } })).toBe(
    0,
  );
  const removeStarter = await page.request.delete(
    `/api/admin/brands/${encodeURIComponent(google!.id)}`,
    { headers: await csrfHeaders(page) },
  );
  expect(removeStarter.status()).toBe(204);
  expect(
    await prisma.catalogDefaultSuppression.findUnique({
      where: { defaultKey: google!.id },
    }),
  ).not.toBeNull();
  await seedCatalogDefaults(prisma);
  expect(
    await prisma.brand.findUnique({ where: { id: google!.id } }),
  ).toBeNull();

  const token = Date.now();
  const rootName = `Catalog UX ${token}`;
  const rootSlug = `catalog-ux-${token}`;
  const createCategory = async (
    name: string,
    slug: string,
    parentId: string | null = null,
  ) => {
    const response = await page.request.post("/api/admin/categories", {
      data: { name, slug, parentId },
      headers: await csrfHeaders(page),
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as {
      id: string;
      slug: string;
      name: string;
    };
  };

  const root = await createCategory(rootName, rootSlug);
  const child = await createCategory(
    `${rootName} Child`,
    `${rootSlug}-child`,
    root.id,
  );
  const leaf = await createCategory(
    `${rootName} Leaf`,
    `${rootSlug}-leaf`,
    child.id,
  );
  const moveTarget = await createCategory(
    `${rootName} Target`,
    `${rootSlug}-target`,
  );
  try {
    const tooDeep = await page.request.patch(
      `/api/admin/categories/${encodeURIComponent(moveTarget.id)}`,
      {
        data: { parentId: leaf.id },
        headers: await csrfHeaders(page),
      },
    );
    expect(tooDeep.status()).toBe(400);
    expect(await tooDeep.json()).toMatchObject({
      error: expect.stringContaining("three-level"),
    });

    const externalImage = await page.request.post("/api/admin/categories", {
      data: {
        name: `${rootName} External Image`,
        slug: `${rootSlug}-external`,
        imageUrl: "https://example.test/logo.png",
      },
      headers: await csrfHeaders(page),
    });
    expect(externalImage.status()).toBe(400);

    await page.goto("/admin/platform?section=taxonomy");
    await expect(
      page.getByRole("heading", { name: "Catalog & categories" }),
    ).toBeVisible();
    for (const width of [320, 375, 480, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const catalog = page.locator(".adminCatalog");
      await expect(catalog).toBeVisible();
      expect(
        await catalog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
        `catalog overflows at ${width}px`,
      ).toBe(true);
    }

    const search = page.getByRole("searchbox", { name: "Search catalog" });
    await search.fill(rootName);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill(`${rootName} Renamed`);
    await page
      .getByRole("button", { name: "Apply suggestion" })
      .scrollIntoViewIfNeeded();
    await expect(dialog.locator(".catalogEditorFooter")).toBeInViewport();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Catalog changes saved." }),
    ).toBeVisible();
    const renamedWithoutSlug = await prisma.category.findUniqueOrThrow({
      where: { id: root.id },
    });
    expect(renamedWithoutSlug).toMatchObject({
      name: `${rootName} Renamed`,
      slug: rootSlug,
    });

    await search.fill(`${rootName} Renamed`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const secondDialog = page.getByRole("dialog");
    await secondDialog.getByLabel("Name").fill(`${rootName} Renamed Again`);
    await secondDialog
      .getByRole("button", { name: "Apply suggestion" })
      .click();
    await secondDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Catalog changes saved." }),
    ).toBeVisible();
    const renamedWithSlug = await prisma.category.findUniqueOrThrow({
      where: { id: root.id },
    });
    expect(renamedWithSlug.slug).toBe(`${rootSlug}-renamed-again`);
    const redirect = await page.request.get(
      `/api/marketplace/categories/${rootSlug}`,
    );
    expect(redirect.ok(), await redirect.text()).toBeTruthy();
    expect(await redirect.json()).toMatchObject({
      redirectTo: `/category/${renamedWithSlug.slug}`,
      statusCode: 301,
    });

    const buyerContext = await page.context().browser()?.newContext();
    if (!buyerContext) throw new Error("Browser context unavailable");
    try {
      const buyer = await buyerContext.newPage();
      await login(buyer, buyerEmail);
      const denied = await buyer.request.post("/api/admin/brands", {
        data: { name: `Unauthorized ${token}`, slug: `unauthorized-${token}` },
        headers: await csrfHeaders(buyer),
      });
      expect(denied.status()).toBe(403);
    } finally {
      await buyerContext.close();
    }
  } finally {
    for (const category of [moveTarget, leaf, child, root]) {
      const response = await page.request.delete(
        `/api/admin/categories/${encodeURIComponent(category.id)}`,
        { headers: await csrfHeaders(page) },
      );
      expect(response.status()).toBe(204);
    }
    await prisma.slugRedirect.deleteMany({
      where: { fromPath: { startsWith: `/category/${rootSlug}` } },
    });
  }
});
