import { expect, test, type Page } from "@playwright/test";

const password = "LocalDemoOnly-ChangeMe-123!";
const adminEmail = "admin.local@example.test";
const sellerEmail = "seller.local@example.test";
const buyerEmail = "buyer.local@example.test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWPwKI/6T0vMMGqBx2gQeYymIo/RjFY+WlSUD/LSFAAuzCQu+qkxfwAAAAB5ErkJggg==",
  "base64",
);

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password },
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

test("platform branding upload keeps a local quarantined image private until scanning is available", async ({
  page,
}) => {
  await login(page, adminEmail);
  const beforeDraft = await page.request.get("/api/admin/platform/branding");
  expect(beforeDraft.ok()).toBeTruthy();
  const beforePublic = await page.request.get("/api/platform/branding");
  expect(beforePublic.ok()).toBeTruthy();

  await page.goto("/admin/platform");
  await page.getByRole("button", { name: "Branding", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Platform branding", exact: true }),
  ).toBeVisible();
  const logoGroup = page.getByRole("group", { name: "Primary logo" });
  await logoGroup.getByLabel("Choose primary logo image").setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(logoGroup.getByText("Crop preview")).toBeVisible();
  await expect(logoGroup.getByLabel("Horizontal crop position")).toBeVisible();
  await expect(logoGroup.getByLabel("Vertical crop position")).toBeVisible();
  const finalizeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/admin\/platform\/branding-media\/[^/]+\/finalize$/.test(
        new URL(response.url()).pathname,
      ),
    { timeout: 25_000 },
  );
  await logoGroup
    .getByRole("button", { name: "Upload primary logo replacement" })
    .click();
  const finalized = await finalizeResponse;
  expect(finalized.status()).toBe(202);
  const finalizedAsset = await finalized.json();
  expect(finalizedAsset).toMatchObject({
    uploadStatus: "COMPLETE",
    scanStatus: "QUARANTINED",
    publicAfterUpload: false,
  });
  await expect(logoGroup.getByRole("status")).toContainText(
    "Image uploaded to private quarantine",
    { timeout: 15_000 },
  );
  await expect(
    logoGroup.getByText(/replacement\.webp: private, awaiting scan/),
  ).toBeVisible();

  const invalidSvg = page.getByLabel("Choose favicon image");
  await invalidSvg.setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(
    page.getByText(
      "Choose a PNG, JPEG, WebP, or GIF image. SVG and other formats are not accepted.",
    ),
  ).toBeVisible();
  const afterDraft = await page.request.get("/api/admin/platform/branding");
  const afterPublic = await page.request.get("/api/platform/branding");
  expect((await afterDraft.json()).draftJson).toEqual(
    (await beforeDraft.json()).draftJson,
  );
  expect(await afterPublic.json()).toEqual(await beforePublic.json());
});

test("branding media APIs deny buyer access and storage failures keep seller image references unchanged", async ({
  page,
}) => {
  await login(page, buyerEmail);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.get("/api/admin/platform/branding-media")).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post("/api/admin/platform/branding-media/uploads", {
        data: {
          fileName: "logo.png",
          contentType: "image/png",
          sizeBytes: png.length,
        },
        headers,
      })
    ).status(),
  ).toBe(403);
  expect((await page.request.get("/api/seller/store-media")).status()).toBe(
    403,
  );

  const buyerContext = page.context();
  await buyerContext.clearCookies();
  await login(page, sellerEmail);
  const beforeResponse = await page.request.get("/api/seller/store-theme");
  expect(beforeResponse.ok()).toBeTruthy();
  const before = await beforeResponse.json();

  await page.goto("/seller/platform");
  const logoGroup = page.getByRole("group", { name: "Store logo" });
  await expect(logoGroup.getByText(/Store media usage:/)).toBeVisible();
  await logoGroup.getByLabel("Choose store logo image").setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: png,
  });
  await logoGroup
    .getByRole("button", { name: "Upload store logo replacement" })
    .click();
  await expect(logoGroup.getByRole("alert")).toContainText(
    "Managed browser uploads are not configured",
  );
  const after = await (
    await page.request.get("/api/seller/store-theme")
  ).json();
  expect(after.draft.logoMediaId).toBe(before.draft.logoMediaId);
  expect(after.published).toEqual(before.published);
});

test("browser flow saves a quarantined branding draft, blocks publication, and removes only the reference", async ({
  page,
}) => {
  await login(page, adminEmail);
  const previousId = "previous-approved-logo";
  const candidateId = "quarantined-logo-candidate";
  const draft = {
    platformName: "Mocked Brand",
    shortName: "Mocked",
    description: "",
    seoDescription: "",
    tagline: "",
    logoMediaId: previousId,
    alternateLogoMediaId: null,
    faviconMediaId: null,
    defaultAvatarMediaId: null,
    socialImageMediaId: null,
    supportEmail: null,
    supportUrl: null,
  };
  let published = { ...draft };
  let savedDraft = { ...draft };
  let signedUploadCount = 0;
  let candidateUploaded = false;
  let lastSavedLogo: string | null = previousId;
  let brandingReadCount = 0;
  let delayNextBrandingRead = false;
  let releaseDelayedBrandingRead: (() => void) | null = null;
  let notifyDelayedBrandingReadStarted: (() => void) | null = null;
  const delayedBrandingRead = new Promise<void>((resolve) => {
    releaseDelayedBrandingRead = resolve;
  });
  const delayedBrandingReadStarted = new Promise<void>((resolve) => {
    notifyDelayedBrandingReadStarted = resolve;
  });

  await page.route("**/api/admin/platform/branding", async (route) => {
    if (route.request().method() === "GET") {
      brandingReadCount += 1;
      if (delayNextBrandingRead) {
        delayNextBrandingRead = false;
        notifyDelayedBrandingReadStarted?.();
        await delayedBrandingRead;
      }
      return route.fulfill({
        json: { draftJson: savedDraft, publishedJson: published },
      });
    }
    if (route.request().method() === "PUT") {
      savedDraft = await route.request().postDataJSON();
      lastSavedLogo = savedDraft.logoMediaId;
      return route.fulfill({
        json: { draftJson: savedDraft, publishedJson: published },
      });
    }
    return route.fallback();
  });
  await page.route("**/api/admin/platform/branding-media", (route) =>
    route.fulfill({
      json: [
        {
          id: previousId,
          originalName: "Previous logo.webp",
          sizeBytes: 100,
          scanStatus: "APPROVED",
          uploadStatus: "COMPLETE",
          storageProvider: "OBJECT",
        },
      ],
    }),
  );
  await page.route("**/api/admin/platform/branding-media/*/preview", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
  await page.route("**/api/admin/platform/branding-media/uploads", (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: candidateId,
        upload: {
          url: "https://managed-upload.invalid/presigned",
          fields: { key: candidateId },
        },
        scanStatus: "QUARANTINED",
        publicAfterUpload: false,
      },
    }),
  );
  await page.route("https://managed-upload.invalid/**", async (route) => {
    signedUploadCount += 1;
    await route.fulfill({ status: 201, body: "" });
  });
  await page.route(
    `**/api/admin/platform/branding-media/${candidateId}/finalize`,
    (route) => {
      candidateUploaded = true;
      return route.fulfill({
        json: {
          id: candidateId,
          uploadStatus: "COMPLETE",
          scanStatus: "QUARANTINED",
          publicAfterUpload: false,
          message: "Private until scanning approves it.",
        },
      });
    },
  );
  await page.route("**/api/admin/platform/branding-media", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: [
          {
            id: previousId,
            originalName: "Previous logo.webp",
            sizeBytes: 100,
            scanStatus: "APPROVED",
            uploadStatus: "COMPLETE",
            storageProvider: "OBJECT",
          },
          ...(candidateUploaded
            ? [
                {
                  id: candidateId,
                  originalName: "replacement.webp",
                  sizeBytes: 100,
                  scanStatus: "QUARANTINED",
                  uploadStatus: "COMPLETE",
                  storageProvider: "OBJECT",
                },
              ]
            : []),
        ],
      });
    return route.fallback();
  });
  await page.route("**/api/admin/platform/branding/publish", async (route) => {
    if (savedDraft.logoMediaId === candidateId)
      return route.fulfill({
        status: 409,
        json: {
          error: "Branding or theme media must be approved before publishing",
        },
      });
    published = { ...savedDraft };
    return route.fulfill({ json: { publishedJson: published } });
  });

  await page.goto("/admin/platform");
  await page.getByRole("button", { name: "Branding", exact: true }).click();
  await expect.poll(() => brandingReadCount).toBe(1);
  const logoGroup = page.getByRole("group", { name: "Primary logo" });
  await logoGroup.getByLabel("Choose primary logo image").setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: png,
  });
  await logoGroup
    .getByRole("button", { name: "Upload primary logo replacement" })
    .click();
  await expect(logoGroup.getByRole("status")).toContainText(
    "not available publicly until scanning approves it",
  );
  await expect(logoGroup.getByRole("status")).toContainText(
    "current public image remains active meanwhile",
  );
  await expect(
    logoGroup.getByLabel("Primary logo from media library"),
  ).toHaveValue(candidateId);
  await expect(
    logoGroup.getByText("Draft preview · quarantined"),
  ).toBeVisible();
  expect(signedUploadCount).toBe(1);

  delayNextBrandingRead = true;
  const saveCandidateResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/admin/platform/branding") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save branding draft" }).click();
  const saveCandidateResponse = await saveCandidateResponsePromise;
  expect(saveCandidateResponse.status()).toBe(200);
  expect((await saveCandidateResponse.json()).draftJson.logoMediaId).toBe(
    candidateId,
  );
  await delayedBrandingReadStarted;
  await page
    .getByLabel("Tagline")
    .fill("Edited while server refresh is in flight");
  releaseDelayedBrandingRead?.();
  releaseDelayedBrandingRead = null;
  await expect(page.getByLabel("Tagline")).toHaveValue(
    "Edited while server refresh is in flight",
  );
  await expect(
    page.getByText(
      "Platform branding draft saved. Newer edits remain unsaved in the editor.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(lastSavedLogo).toBe(candidateId);
  let dialogMessage = "";
  page.once("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Save and publish branding" }).click();
  await expect
    .poll(() => dialogMessage)
    .toContain("Only approved images will be made public");
  await expect(
    page.getByText(
      /Branding draft was saved, but publishing failed: Branding or theme media must be approved before publishing/,
    ),
  ).toBeVisible();
  expect(published.logoMediaId).toBe(previousId);

  await logoGroup.getByRole("button", { name: "Remove from draft" }).click();
  await expect(
    logoGroup.getByLabel("Primary logo from media library"),
  ).toHaveValue("");
  const saveRemovalResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/admin/platform/branding") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save branding draft" }).click();
  const saveRemovalResponse = await saveRemovalResponsePromise;
  expect(saveRemovalResponse.status()).toBe(200);
  expect((await saveRemovalResponse.json()).draftJson.logoMediaId).toBeNull();
  await expect(
    page.getByText(
      "Platform branding draft saved and verified from the server.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(lastSavedLogo).toBeNull();
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Save and publish branding" }).click();
  await expect.poll(() => published.logoMediaId).toBeNull();
});

test("Store Plan media quota is shown and a quota response prevents a seller replacement", async ({
  page,
}) => {
  await login(page, sellerEmail);
  const before = await (
    await page.request.get("/api/seller/store-theme")
  ).json();
  await page.route("**/api/seller/store-media", (route) =>
    route.fulfill({ json: { usedBytes: 4096, limitBytes: 4096, assets: [] } }),
  );
  await page.route("**/api/seller/store-media/uploads", (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: "PLAN_LIMIT_REACHED",
        error: "Your Store has reached its media storage limit.",
      },
    }),
  );
  await page.goto("/seller/platform");
  const logoGroup = page.getByRole("group", { name: "Store logo" });
  await expect(
    logoGroup.getByText("Store media usage: 4,096 of 4,096 bytes."),
  ).toBeVisible();
  await logoGroup.getByLabel("Choose store logo image").setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: png,
  });
  await logoGroup
    .getByRole("button", { name: "Upload store logo replacement" })
    .click();
  await expect(logoGroup.getByRole("alert")).toContainText(
    "Your Store has reached its media storage limit",
  );
  const after = await (
    await page.request.get("/api/seller/store-theme")
  ).json();
  expect(after.draft.logoMediaId).toBe(before.draft.logoMediaId);
  expect(after.published).toEqual(before.published);
});

test("seller can stage and publish a Store favicon only after approval, then remove its public reference", async ({
  page,
}) => {
  await login(page, sellerEmail);
  const initialResponse = await page.request.get("/api/seller/store-theme");
  expect(initialResponse.ok()).toBeTruthy();
  const initial = await initialResponse.json();
  const candidateId = "store-favicon-candidate";
  let draft = { ...initial.draft, faviconMediaId: null };
  let published = initial.published ? { ...initial.published } : null;
  let scannerApproved = false;

  await page.route("**/api/seller/store-theme", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { ...initial, draft, published } });
    if (route.request().method() === "PUT") {
      draft = route.request().postDataJSON();
      return route.fulfill({
        json: { id: initial.storeId, slug: initial.slug },
      });
    }
    return route.fallback();
  });
  await page.route("**/api/seller/store-theme/publish", async (route) => {
    if (!scannerApproved && draft.faviconMediaId === candidateId)
      return route.fulfill({
        status: 409,
        json: {
          error: "Branding or theme media must be approved before publishing",
        },
      });
    published = { ...draft };
    return route.fulfill({ json: { themePublishedJson: published } });
  });
  await page.route("**/api/seller/store-media", (route) =>
    route.fulfill({
      json: {
        usedBytes: 0,
        limitBytes: 1_000_000,
        assets: [
          {
            id: candidateId,
            originalName: "favicon.webp",
            kind: "IMAGE",
            sizeBytes: 100,
            scanStatus: scannerApproved ? "APPROVED" : "QUARANTINED",
            uploadStatus: "COMPLETE",
            storageProvider: "OBJECT",
          },
          {
            id: "non-image-store-media",
            originalName: "movie.mp4",
            kind: "VIDEO",
            sizeBytes: 100,
            scanStatus: "APPROVED",
            uploadStatus: "COMPLETE",
            storageProvider: "OBJECT",
          },
        ],
      },
    }),
  );
  await page.route("**/api/seller/store-media/uploads", (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: candidateId,
        upload: {
          url: "https://managed-upload.invalid/presigned",
          fields: { key: candidateId },
        },
        scanStatus: "QUARANTINED",
        publicAfterUpload: false,
      },
    }),
  );
  await page.route(
    `**/api/seller/store-media/${candidateId}/finalize`,
    (route) =>
      route.fulfill({
        json: {
          id: candidateId,
          uploadStatus: "COMPLETE",
          scanStatus: "QUARANTINED",
          publicAfterUpload: false,
        },
      }),
  );
  await page.route("**/api/seller/store-media/*/preview", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
  await page.route("https://managed-upload.invalid/**", (route) =>
    route.fulfill({ status: 201, body: "" }),
  );
  await page.route(`**/api/stores/${initial.slug}`, (route) =>
    route.fulfill({
      json: {
        storeId: initial.storeId,
        name: initial.name,
        slug: initial.slug,
        publicPath: initial.publicPath,
        theme: published ?? initial.draft,
        products: [],
      },
    }),
  );
  await page.route(`**/api/stores/${initial.slug}/content`, (route) =>
    route.fulfill({ json: { posts: [], pages: [] } }),
  );
  await page.route(`**/api/stores/${initial.slug}/currencies`, (route) =>
    route.fulfill({
      json: {
        baseCurrency: "USD",
        currencies: [
          {
            code: "USD",
            name: "US Dollar",
            displayAvailable: true,
            rate: null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/account/preferences", (route) =>
    route.fulfill({ json: { preference: { displayCurrency: "USD" } } }),
  );

  await page.goto("/seller/platform");
  await expect(page.getByLabel("Store name")).toHaveValue(initial.name);
  const faviconGroup = page.getByRole("group", { name: "Store favicon" });
  await faviconGroup.getByLabel("Choose store favicon image").setInputFiles({
    name: "store-favicon.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(faviconGroup.getByText("Crop preview")).toBeVisible();
  await faviconGroup
    .getByRole("button", { name: "Upload store favicon replacement" })
    .click();
  await expect(faviconGroup.getByRole("status")).toContainText(
    "not available publicly until scanning approves it",
  );
  await expect(faviconGroup.getByRole("status")).toContainText(
    "current public image remains active meanwhile",
  );
  await expect(
    faviconGroup.getByLabel("Store favicon from media library"),
  ).toHaveValue(candidateId);
  const saveDraftResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/seller/store-theme") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const saveDraftResponse = await saveDraftResponsePromise;
  expect(saveDraftResponse.status()).toBe(200);
  expect((await saveDraftResponse.json()).slug).toBe(initial.slug);
  await expect.poll(() => draft.faviconMediaId).toBe(candidateId);
  await expect(
    page.getByText("Store settings draft saved", { exact: true }),
  ).toBeVisible();

  const blockedPublishResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/seller/store-theme/publish") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const blockedPublishResponse = await blockedPublishResponsePromise;
  expect(blockedPublishResponse.status()).toBe(409);
  await expect(
    page.getByText(
      /Store appearance draft was saved, but publishing failed: Branding or theme media must be approved before publishing/,
    ),
  ).toBeVisible();
  expect(published?.faviconMediaId).not.toBe(candidateId);

  scannerApproved = true;
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(() => published?.faviconMediaId).toBe(candidateId);
  const faviconLibrary = faviconGroup.getByLabel(
    "Store favicon from media library",
  );
  await expect(faviconLibrary.locator("option")).toHaveCount(2);
  await expect(faviconLibrary.locator("option").nth(1)).toHaveText(
    /favicon\.webp/,
  );
  await expect(
    faviconLibrary.locator('option[value="non-image-store-media"]'),
  ).toHaveCount(0);
  await page.goto(`/store/${initial.slug}`);
  await expect(
    page.getByRole("link", { name: `${initial.name} Store homepage` }),
  ).toBeVisible();
  await expect(page.locator("link[data-store-branding-icon]")).toHaveAttribute(
    "href",
    `/content-media/${candidateId}`,
  );

  await page.goto("/seller/platform");
  const removeGroup = page.getByRole("group", { name: "Store favicon" });
  await removeGroup.getByRole("button", { name: "Remove from draft" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(() => published?.faviconMediaId).toBeNull();
  await page.goto(`/store/${initial.slug}`);
  await expect(page.locator("link[data-store-branding-icon]")).toHaveCount(0);
});
