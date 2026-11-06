import { expect, test, type Page } from "@playwright/test";

const password = "LocalDemoOnly-ChangeMe-123!";
const adminEmail = "admin.local@example.test";
const sellerEmail = "seller.local@example.test";

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

async function setColor(page: Page, label: string, color: string) {
  await page.getByLabel(label).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, color);
}

test("legacy/free seller can view the builder but cannot save or publish premium chrome", async ({
  page,
}) => {
  await login(page, sellerEmail);
  await page.goto("/seller/site-chrome");
  await expect(
    page.getByRole("heading", { name: "Header & footer builder" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A paid Store Plan is required to publish custom site chrome.",
    ),
  ).toBeVisible();
  const response = await page.request.get("/api/seller/site-chrome");
  expect(response.ok(), await response.text()).toBeTruthy();
  const state = (await response.json()) as {
    eligible: boolean;
    draft: unknown;
    draftVersion: number;
  };
  expect(state.eligible).toBe(false);
  const save = await page.request.put("/api/seller/site-chrome", {
    data: {
      expectedVersion: state.draftVersion,
      configuration: state.draft,
      reason: "Verify free-plan restriction",
    },
    headers: await csrfHeaders(page),
  });
  expect(save.status()).toBe(403);
  const publish = await page.request.post("/api/seller/site-chrome/publish", {
    data: { expectedVersion: state.draftVersion },
    headers: await csrfHeaders(page),
  });
  expect(publish.status()).toBe(403);
});

test("custom brand colors show WCAG AA contrast warnings before publication", async ({
  page,
}) => {
  await login(page, adminEmail);
  await page.goto("/admin/platform?section=chrome");
  await page.getByRole("tab", { name: "Header" }).click();
  await setColor(page, "Background color", "#ffffff");
  await setColor(page, "Text color", "#ffffff");
  await expect(
    page.locator(".siteChromeContrastWarning").first(),
  ).toContainText("WCAG AA");
  await page.getByRole("tab", { name: "Footer" }).click();
  await setColor(page, "Text color", "#edf3ed");
  await expect(
    page.locator(".siteChromeContrastWarning").first(),
  ).toContainText("Footer text / background");
});
