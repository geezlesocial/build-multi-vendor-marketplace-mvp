import { expect, test, type Page } from "@playwright/test";

const password = "LocalDemoOnly-ChangeMe-123!";

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("admin can return to the permitted dashboard home from a module", async ({
  page,
}) => {
  await login(page, "admin.local@example.test");
  await page.goto("/admin/platform?section=taxonomy");

  await expect(
    page.getByRole("heading", { name: "Control center", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Back to dashboard" }).click();

  await expect(page).toHaveURL(/\/admin\/platform\?section=overview$/);
  await expect(
    page.getByRole("heading", { name: "Marketplace operations" }),
  ).toBeVisible();
});

test("standalone admin modules offer safe previous-page and dashboard links", async ({
  page,
}) => {
  await login(page, "admin.local@example.test");
  await page.goto("/admin/currencies");

  await expect(
    page.getByRole("heading", { name: "Currency catalog and FX" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go back to the previous page" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to admin dashboard" }),
  ).toHaveAttribute("href", "/admin/platform");

  const navigation = page.getByRole("navigation", {
    name: "Workspace navigation",
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect
    .poll(() =>
      navigation.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);

  const previousPage = page.getByRole("button", {
    name: "Go back to the previous page",
  });
  await previousPage.focus();
  await expect(previousPage).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/platform(?:\?.*)?$/);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Currency catalog & FX" }).click();
  await expect(page).toHaveURL(/\/admin\/currencies$/);
  await page
    .getByRole("button", { name: "Go back to the previous page" })
    .click();
  await expect(page).toHaveURL(/\/admin\/platform(?:\?.*)?$/);
});

test("buyer dashboard tabs provide an accessible keyboard return to overview", async ({
  page,
}) => {
  await login(page, "buyer.local@example.test");
  let releaseAccess!: () => void;
  const accessGate = new Promise<void>((resolve) => {
    releaseAccess = resolve;
  });
  await page.route("**/api/dashboard/access", async (route) => {
    await accessGate;
    await route.continue();
  });
  await page.goto("/dashboard?tab=orders");

  const loading = page.locator(".workspaceLoadingPage");
  try {
    await expect(
      loading.getByRole("heading", { name: "Preparing your dashboard" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(loading).toHaveAttribute("role", "status");
    await expect(loading).toHaveAttribute("aria-busy", "true");
    await expect(loading.locator(".workspaceLoadingSkeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  } finally {
    releaseAccess();
  }

  await expect(
    page.getByRole("heading", { name: "Buyer dashboard" }),
  ).toBeVisible();
  const backToDashboard = page.getByRole("button", {
    name: "Back to dashboard",
  });
  await expect(backToDashboard).toHaveCount(1);
  await backToDashboard.focus();
  await expect(backToDashboard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
});
