import { expect, test, type Page } from "@playwright/test";
import { createTestPrismaClient } from "../scripts/prisma-test-client.mjs";
import { createServer, type Server } from "node:http";
import { validateE2EDatabaseURL } from "../scripts/e2e-database-url.mjs";

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error("E2E_DATABASE_URL is required for Jima tests.");
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);
const recommendationFixtureProductIds: string[] = [];
const recommendationFixtureCategoryIds: string[] = [];
test.afterEach(async () => {
  if (recommendationFixtureProductIds.length) {
    await prisma.favorite.deleteMany({
      where: { productId: { in: recommendationFixtureProductIds } },
    });
    await prisma.storeInterestSignal.deleteMany({
      where: { productId: { in: recommendationFixtureProductIds } },
    });
    await prisma.product.updateMany({
      where: { id: { in: recommendationFixtureProductIds } },
      data: { status: "ARCHIVED" },
    });
    recommendationFixtureProductIds.length = 0;
  }
  if (recommendationFixtureCategoryIds.length) {
    await prisma.category.deleteMany({
      where: { id: { in: recommendationFixtureCategoryIds } },
    });
    recommendationFixtureCategoryIds.length = 0;
  }
});
test.afterAll(async () => prisma.$disconnect());

async function login(page: Page, email: string) {
  const response = await page.request.post("/api/auth/login", {
    data: { email, password: "LocalDemoOnly-ChangeMe-123!" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function csrf(page: Page) {
  await page.request.get("/api/ai/status");
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "marketplace_csrf",
  );
  expect(cookie).toBeTruthy();
  return { "x-csrf-token": cookie!.value };
}

test("Jima keeps admin controls private and reports honest disabled/runtime states", async ({
  page,
}) => {
  // A cold Vite transform can take longer than the navigation load event on
  // this large app. Wait for the actual Settings UI and its async data instead.
  test.setTimeout(60_000);
  const anon = await page.request.get("/api/admin/jima/config");
  expect(anon.status()).toBe(401);
  expect((await page.request.get("/api/admin/jima/metrics")).status()).toBe(
    401,
  );
  expect(
    (await page.request.get("/api/admin/jima/config/versions")).status(),
  ).toBe(401);
  await login(page, "buyer.local@example.test");
  const denied = await page.request.get("/api/admin/jima/config");
  expect(denied.status()).toBe(403);
  expect((await page.request.get("/api/admin/jima/metrics")).status()).toBe(
    403,
  );
  expect(
    (await page.request.get("/api/admin/jima/config/versions")).status(),
  ).toBe(403);
  const chat = await page.request.post("/api/ai/chat", {
    headers: await csrf(page),
    data: { message: "Where can I find products?" },
  });
  expect(chat.status()).toBe(503);
  expect((await chat.json()).error).toContain("unavailable");

  const buyer = await prisma.user.findUniqueOrThrow({
    where: { email: "buyer.local@example.test" },
  });
  const conversation = await prisma.jimaConversation.create({
    data: { userId: buyer.id, title: "Support handoff E2E" },
  });
  await prisma.jimaMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: "I need a human to help with my marketplace account.",
    },
  });
  const ticketCountBefore = await prisma.supportTicket.count({
    where: { buyerId: buyer.id, subject: "Jima AI support request" },
  });
  const noConsent = await page.request.post(
    `/api/ai/conversations/${conversation.id}/handoff`,
    { headers: await csrf(page), data: {} },
  );
  expect(noConsent.status()).toBe(400);
  expect(
    await prisma.supportTicket.count({
      where: { buyerId: buyer.id, subject: "Jima AI support request" },
    }),
  ).toBe(ticketCountBefore);
  const handoff = await page.request.post(
    `/api/ai/conversations/${conversation.id}/handoff`,
    { headers: await csrf(page), data: { includeConversation: true } },
  );
  expect(handoff.status()).toBe(201);
  const ticketInfo = await handoff.json();
  expect(ticketInfo.status).toBe("OPEN");
  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: ticketInfo.ticketId },
    include: { messages: true },
  });
  expect(ticket.messages[0]?.body).toContain("human to help");
  const retriedHandoff = await page.request.post(
    `/api/ai/conversations/${conversation.id}/handoff`,
    { headers: await csrf(page), data: { includeConversation: true } },
  );
  expect(retriedHandoff.status()).toBe(200);
  expect((await retriedHandoff.json()).ticketId).toBe(ticketInfo.ticketId);
  expect(
    await prisma.supportTicket.count({
      where: { buyerId: buyer.id, subject: "Jima AI support request" },
    }),
  ).toBe(ticketCountBefore + 1);

  await page.request.post("/api/auth/logout", { headers: await csrf(page) });
  await login(page, "seller.local@example.test");
  const crossUserDelete = await page.request.delete(
    `/api/ai/conversations/${conversation.id}`,
    { headers: await csrf(page) },
  );
  expect(crossUserDelete.status()).toBe(404);
  await page.request.post("/api/auth/logout", { headers: await csrf(page) });
  await login(page, "buyer.local@example.test");
  const history = await page.request.get("/api/ai/conversations");
  expect(
    (await history.json()).some(
      (item: { id: string }) => item.id === conversation.id,
    ),
  ).toBeTruthy();
  await page.goto("/settings", { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
    timeout: 30_000,
  });
  const privacy = page.locator("section.settingsCard").filter({
    has: page.getByRole("heading", { name: "Jima conversation data" }),
  });
  await expect(privacy.getByRole("status")).toHaveText(
    "Your conversation titles and last activity are shown here.",
    { timeout: 20_000 },
  );
  await expect(privacy.getByText("Support handoff E2E")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await privacy.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(privacy.getByText("Support handoff E2E")).toHaveCount(0);
  await expect(
    prisma.jimaConversation.findUnique({ where: { id: conversation.id } }),
  ).resolves.toBeNull();
  await page.request.post("/api/auth/logout", { headers: await csrf(page) });
  await login(page, "admin.local@example.test");
  const config = await page.request.get("/api/admin/jima/config");
  const value = await config.json();
  const externalRuntime = await page.request.patch("/api/admin/jima/config", {
    headers: await csrf(page),
    data: { ...value, runtimeUrl: "https://example.com" },
  });
  expect(externalRuntime.status()).toBe(400);
  const save = await page.request.patch("/api/admin/jima/config", {
    headers: await csrf(page),
    data: { ...value, enabled: false, retentionDays: 7 },
  });
  expect(save.ok()).toBeTruthy();
  const savedConfig = await save.json();
  expect(savedConfig.retentionDays).toBe(7);
  const historyResponse = await page.request.get(
    "/api/admin/jima/config/versions",
  );
  expect(historyResponse.ok()).toBeTruthy();
  const configVersions = (await historyResponse.json()) as {
    id: string;
    config: { retentionDays: number };
  }[];
  const savedVersion = configVersions.find(
    (version) => version.config.retentionDays === 7,
  );
  expect(savedVersion).toBeTruthy();
  const newerSave = await page.request.patch("/api/admin/jima/config", {
    headers: await csrf(page),
    data: { ...savedConfig, retentionDays: 14 },
  });
  expect(newerSave.ok(), await newerSave.text()).toBeTruthy();
  expect((await newerSave.json()).retentionDays).toBe(14);
  const restore = await page.request.post(
    `/api/admin/jima/config/versions/${savedVersion!.id}/restore`,
    { headers: await csrf(page), data: {} },
  );
  expect(restore.ok(), await restore.text()).toBeTruthy();
  expect((await restore.json()).retentionDays).toBe(7);
  const restoredHistory = await page.request.get(
    "/api/admin/jima/config/versions",
  );
  expect(
    (await restoredHistory.json()).some(
      (version: { action: string }) =>
        version.action === "JIMA_CONFIGURATION_ROLLED_BACK",
    ),
  ).toBeTruthy();
  const article = await page.request.post("/api/admin/jima/knowledge", {
    headers: await csrf(page),
    data: {
      title: "E2E help draft",
      body: "Approved draft help.",
      audience: "PUBLIC",
      published: false,
    },
  });
  expect(article.status()).toBe(200);
  expect((await article.json()).published).toBe(false);
  await page.goto("/admin/platform?section=jima");
  await expect(
    page.getByRole("heading", { name: "Jima System AI" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Configuration history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Model calls are disabled until an administrator enables them.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test local runtime" }),
  ).toBeDisabled();
});

test("Jima uses a local Ollama-compatible fixture, scopes knowledge, and hands off to a replying support agent", async ({
  page,
}) => {
  const capturedMessages: {
    model: string;
    messages: { role: string; content: string }[];
  }[] = [];
  const pageProduct = await prisma.product.findFirstOrThrow({
    where: { status: "APPROVED" },
    select: {
      id: true,
      name: true,
      seller: { select: { store: { select: { slug: true, name: true } } } },
    },
  });
  let buyerArticleId = "";
  const fixture: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ models: [{ name: "fixture:latest" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/chat") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(raw) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      capturedMessages.push(request);
      if (request.model === "fixture:not-installed") {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "model not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          message: { content: "Fixture reply grounded in approved help." },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Ollama-compatible E2E fixture did not bind.");
  const runtimeUrl = `http://127.0.0.1:${address.port}`;

  try {
    await login(page, "admin.local@example.test");
    const headers = await csrf(page);
    const saved = await page.request.get("/api/admin/jima/config");
    const originalConfig = await saved.json();
    const config = {
      ...originalConfig,
      enabled: true,
      widgetEnabled: true,
      runtimeUrl,
      model: "fixture:not-installed",
    };
    const savedConfig = await page.request.patch("/api/admin/jima/config", {
      headers,
      data: config,
    });
    expect(savedConfig.ok(), await savedConfig.text()).toBeTruthy();
    for (const [audience, label] of [
      ["PUBLIC", "public"],
      ["BUYER", "buyer-only"],
      ["SELLER", "seller-only"],
    ] as const) {
      const result = await page.request.post("/api/admin/jima/knowledge", {
        headers,
        data: {
          title: `Fixture audience policy ${label}`,
          body: `fixture audience policy ${label}`,
          audience,
          published: true,
        },
      });
      expect(result.ok(), await result.text()).toBeTruthy();
      if (audience === "BUYER") buyerArticleId = (await result.json()).id;
    }

    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "buyer.local@example.test");
    const unavailable = await page.request.post("/api/ai/chat", {
      headers: await csrf(page),
      data: { message: "fixture audience policy" },
    });
    expect(unavailable.status()).toBe(503);
    expect((await unavailable.json()).error).toContain("local AI runtime");
    const buyerPrompt = capturedMessages.at(-1)?.messages[0]?.content ?? "";
    expect(buyerPrompt).toContain("buyer-only");
    expect(buyerPrompt).toContain("public");
    expect(buyerPrompt).not.toContain("seller-only");

    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "admin.local@example.test");
    const successConfig = await page.request.patch("/api/admin/jima/config", {
      headers: await csrf(page),
      data: { ...config, model: "fixture:latest" },
    });
    expect(successConfig.ok(), await successConfig.text()).toBeTruthy();
    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "buyer.local@example.test");
    const buyerSuccess = await page.request.post("/api/ai/chat", {
      headers: await csrf(page),
      data: {
        message: "fixture audience policy",
        pagePath: `/products/${pageProduct.id}`,
      },
    });
    expect(buyerSuccess.ok(), await buyerSuccess.text()).toBeTruthy();
    const buyerBody = await buyerSuccess.json();
    expect(buyerBody.answer).toBe("Fixture reply grounded in approved help.");
    expect(buyerBody.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "product",
          href: `/products/${pageProduct.id}`,
          title: pageProduct.name,
        }),
        expect.objectContaining({
          type: "help",
          href: `/help/jima/${buyerArticleId}`,
        }),
      ]),
    );
    expect(
      buyerBody.sources.some((source: { title: string }) =>
        source.title.includes("seller-only"),
      ),
    ).toBe(false);
    const successfulBuyerPrompt =
      capturedMessages.at(-1)?.messages[0]?.content ?? "";
    expect(successfulBuyerPrompt).toContain("buyer-only");
    expect(successfulBuyerPrompt).not.toContain("seller-only");
    expect(successfulBuyerPrompt).toContain(pageProduct.name);
    const linkedArticle = await page.request.get(
      `/api/ai/knowledge/${buyerArticleId}`,
    );
    expect(linkedArticle.status()).toBe(200);
    expect((await linkedArticle.json()).title).toContain("buyer-only");

    if (pageProduct.seller?.store) {
      const storeQuestion = await page.request.post("/api/ai/chat", {
        headers: await csrf(page),
        data: {
          message: pageProduct.seller.store.name,
          pagePath: `/store/${pageProduct.seller.store.slug}`,
        },
      });
      expect(storeQuestion.ok(), await storeQuestion.text()).toBeTruthy();
      const storeAnswer = await storeQuestion.json();
      expect(storeAnswer.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "store",
            href: `/store/${pageProduct.seller.store.slug}`,
            title: pageProduct.seller.store.name,
          }),
        ]),
      );
      expect(capturedMessages.at(-1)?.messages[0]?.content).toContain(
        pageProduct.seller.store.name,
      );
    }
    await page.goto(`/products/${pageProduct.id}`);
    await page.getByRole("button", { name: "Open Jima AI assistant" }).click();
    await page.getByLabel("Message Jima").fill("fixture audience policy");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.locator(`.jimaSourceList a[href="/help/jima/${buyerArticleId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`.jimaSourceList a[href="/products/${pageProduct.id}"]`),
    ).toBeVisible();
    const handoffButton = page.getByRole("button", {
      name: "Request human support",
    });
    await expect(handoffButton).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: /Share this conversation with a human support agent/,
      })
      .check();
    await expect(handoffButton).toBeEnabled();
    await handoffButton.click();
    await expect(
      page.getByRole("link", { name: /View support ticket SUP-/ }),
    ).toBeVisible();

    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "seller.local@example.test");
    const sellerReply = await page.request.post("/api/ai/chat", {
      headers: await csrf(page),
      data: { message: "fixture audience policy" },
    });
    expect(sellerReply.ok(), await sellerReply.text()).toBeTruthy();
    const sellerBody = await sellerReply.json();
    expect(sellerBody.answer).toBe("Fixture reply grounded in approved help.");
    const sellerPrompt = capturedMessages.at(-1)?.messages[0]?.content ?? "";
    expect(sellerPrompt).toContain("seller-only");
    expect(sellerPrompt).toContain("public");
    expect(sellerPrompt).not.toContain("buyer-only");
    expect(
      (await page.request.get(`/api/ai/knowledge/${buyerArticleId}`)).status(),
    ).toBe(404);

    const recommendations = await page.request.get("/api/ai/recommendations");
    expect(recommendations.ok(), await recommendations.text()).toBeTruthy();
    const recommendationBody = (await recommendations.json()) as {
      items: { id: string; inventory: { quantity: number } | null }[];
      personalized: boolean;
    };
    expect(recommendationBody.items.length).toBeGreaterThan(0);
    expect(recommendationBody.personalized).toBe(false);
    expect(
      recommendationBody.items.every(
        (item) => (item.inventory?.quantity ?? 0) > 0,
      ),
    ).toBeTruthy();
    const catalogProducts = await prisma.product.findMany({
      where: { status: "APPROVED", inventory: { quantity: { gt: 0 } } },
      select: { id: true },
    });
    expect(
      recommendationBody.items.every((item) =>
        catalogProducts.some((product) => product.id === item.id),
      ),
    ).toBeTruthy();

    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "buyer.local@example.test");
    const handoff = await page.request.post(
      `/api/ai/conversations/${buyerBody.conversationId}/handoff`,
      { headers: await csrf(page), data: { includeConversation: true } },
    );
    expect(handoff.status()).toBe(201);
    const ticketInfo = await handoff.json();
    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "admin.local@example.test");
    const metricsResponse = await page.request.get("/api/admin/jima/metrics");
    expect(metricsResponse.ok(), await metricsResponse.text()).toBeTruthy();
    const metrics = await metricsResponse.json();
    expect(metrics.successfulChats).toBeGreaterThan(0);
    expect(metrics.runtimeOutcomes.UNAVAILABLE).toBeGreaterThan(0);
    expect(metrics.contentStored).toBe(false);
    const agentReply = await page.request.post(
      `/api/support/tickets/${ticketInfo.ticketId}/messages`,
      {
        headers: await csrf(page),
        data: { body: "A support agent has reviewed this request." },
      },
    );
    expect(agentReply.status()).toBe(201);
    await page.request.post("/api/auth/logout", { headers: await csrf(page) });
    await login(page, "buyer.local@example.test");
    const ticket = await page.request.get(
      `/api/support/tickets/${ticketInfo.ticketId}`,
    );
    expect(ticket.ok(), await ticket.text()).toBeTruthy();
    const ticketBody = await ticket.json();
    expect(
      ticketBody.messages.some(
        (message: { body: string; authorRole: string }) =>
          message.body === "A support agent has reviewed this request." &&
          message.authorRole === "ADMIN",
      ),
    ).toBeTruthy();
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

test("Jima recommendations only use activity while consent is enabled and delete signals on opt-out", async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  const category = await prisma.category.create({
    data: { name: `Jima Consent ${suffix}`, slug: `jima-consent-${suffix}` },
  });
  const otherCategory = await prisma.category.create({
    data: { name: `Jima Other ${suffix}`, slug: `jima-other-${suffix}` },
  });
  recommendationFixtureCategoryIds.push(category.id, otherCategory.id);
  const seller = await prisma.seller.findFirstOrThrow({
    where: { user: { email: "seller.local@example.test" }, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: {
      seller: { connect: { id: seller.id } },
      category: { connect: { id: category.id } },
      productType: { connect: { slug: "physical-product" } },
      name: `Jima consent fixture ${suffix}`,
      slug: `jima-consent-fixture-${suffix}`,
      description: "In-stock product for consent-isolated recommendations.",
      priceMinor: 1800,
      status: "APPROVED",
      inventory: { create: { quantity: 4 } },
    },
    select: { id: true },
  });
  recommendationFixtureProductIds.push(product.id);
  const newerProduct = await prisma.product.create({
    data: {
      seller: { connect: { id: seller.id } },
      category: { connect: { id: otherCategory.id } },
      productType: { connect: { slug: "physical-product" } },
      name: `Jima newer fixture ${suffix}`,
      slug: `jima-newer-fixture-${suffix}`,
      description: "A newer unrelated in-stock recommendation fixture.",
      priceMinor: 2100,
      status: "APPROVED",
      inventory: { create: { quantity: 4 } },
    },
    select: { id: true },
  });
  recommendationFixtureProductIds.push(newerProduct.id);
  const buyer = await prisma.user.findUniqueOrThrow({
    where: { email: "buyer.local@example.test" },
  });
  await login(page, "buyer.local@example.test");
  const normalizeConsent = await page.request.patch(
    "/api/account/personalization",
    { headers: await csrf(page), data: { enabled: false } },
  );
  expect(normalizeConsent.ok(), await normalizeConsent.text()).toBeTruthy();
  await page.goto("/settings");
  const card = page.locator("section.settingsCard").filter({
    has: page.getByRole("heading", { name: "Personalization", exact: true }),
  });
  const toggle = card.getByRole("button");
  await expect(toggle).toHaveText("Off");

  const ignoredSignal = await page.request.post("/api/store-buster/signals", {
    headers: await csrf(page),
    data: { type: "SEARCH_CATEGORY", categoryId: category.id },
  });
  expect(ignoredSignal.status()).toBe(204);
  await expect(
    prisma.storeInterestSignal.count({ where: { userId: buyer.id } }),
  ).resolves.toBe(0);
  const optedOut = await page.request.get("/api/ai/recommendations");
  expect(optedOut.ok(), await optedOut.text()).toBeTruthy();
  const optedOutBody = (await optedOut.json()) as {
    items: { id: string; inventory: { quantity: number } | null }[];
    personalized: boolean;
  };
  expect(optedOutBody.personalized).toBe(false);
  expect(
    optedOutBody.items.some((item) => item.id === product.id),
  ).toBeTruthy();
  expect(
    optedOutBody.items.every((item) => (item.inventory?.quantity ?? 0) > 0),
  ).toBeTruthy();

  await toggle.click();
  await expect(toggle).toHaveText("On");
  const consent = await page.request.get("/api/account/personalization");
  expect(await consent.json()).toMatchObject({ personalizationEnabled: true });
  const unpersonalized = await page.request.get("/api/ai/recommendations");
  const unpersonalizedBody = (await unpersonalized.json()) as {
    items: { id: string }[];
    personalized: boolean;
  };
  expect(unpersonalizedBody.items[0]?.id).not.toBe(product.id);

  const liked = await page.request.post(`/api/favorites/${product.id}`, {
    headers: await csrf(page),
    data: {},
  });
  expect(liked.status(), await liked.text()).toBe(201);
  const favoritePersonalized = await page.request.get(
    "/api/ai/recommendations",
  );
  expect(
    favoritePersonalized.ok(),
    await favoritePersonalized.text(),
  ).toBeTruthy();
  const favoritePersonalizedBody = (await favoritePersonalized.json()) as {
    items: { id: string }[];
    personalized: boolean;
  };
  expect(favoritePersonalizedBody.personalized).toBe(true);
  expect(favoritePersonalizedBody.items[0]?.id).toBe(product.id);
  await expect(
    prisma.storeInterestSignal.count({
      where: { userId: buyer.id, productId: product.id, type: "FAVORITE" },
    }),
  ).resolves.toBe(1);

  const unliked = await page.request.delete(`/api/favorites/${product.id}`, {
    headers: await csrf(page),
  });
  expect(unliked.status()).toBe(204);
  const afterUnlike = await page.request.get("/api/ai/recommendations");
  const afterUnlikeBody = (await afterUnlike.json()) as {
    items: { id: string }[];
    personalized: boolean;
  };
  expect(afterUnlikeBody.items[0]?.id).not.toBe(product.id);

  const acceptedSignal = await page.request.post("/api/store-buster/signals", {
    headers: await csrf(page),
    data: { type: "SEARCH_CATEGORY", categoryId: category.id },
  });
  expect(acceptedSignal.status()).toBe(204);
  await expect(
    prisma.storeInterestSignal.count({
      where: { userId: buyer.id, categoryId: category.id },
    }),
  ).resolves.toBe(1);

  const personalized = await page.request.get("/api/ai/recommendations");
  expect(personalized.ok(), await personalized.text()).toBeTruthy();
  const personalizedBody = (await personalized.json()) as {
    items: { id: string; inventory: { quantity: number } | null }[];
    personalized: boolean;
  };
  expect(personalizedBody.personalized).toBe(true);
  expect(personalizedBody.items[0]?.id).toBe(product.id);
  expect(
    personalizedBody.items.every((item) => (item.inventory?.quantity ?? 0) > 0),
  ).toBeTruthy();

  await toggle.click();
  await expect(toggle).toHaveText("Off");
  expect(
    await (await page.request.get("/api/account/personalization")).json(),
  ).toMatchObject({
    personalizationEnabled: false,
    personalizationConsentAt: null,
  });
  await expect(
    prisma.storeInterestSignal.count({ where: { userId: buyer.id } }),
  ).resolves.toBe(0);
  const afterOptOutSignal = await page.request.post(
    "/api/store-buster/signals",
    {
      headers: await csrf(page),
      data: { type: "SEARCH_CATEGORY", categoryId: category.id },
    },
  );
  expect(afterOptOutSignal.status()).toBe(204);
  await expect(
    prisma.storeInterestSignal.count({ where: { userId: buyer.id } }),
  ).resolves.toBe(0);
  const resetRecommendations = await page.request.get(
    "/api/ai/recommendations",
  );
  expect(
    resetRecommendations.ok(),
    await resetRecommendations.text(),
  ).toBeTruthy();
  const resetBody = (await resetRecommendations.json()) as {
    items: { id: string }[];
    personalized: boolean;
  };
  expect(resetBody.personalized).toBe(false);
  expect(resetBody.items.some((item) => item.id === product.id)).toBeTruthy();
  expect(resetBody.items.length).toBeGreaterThan(0);
});

test("Jima recommendation placements and result limits are administrator-controlled and enforced by the API", async ({
  page,
}) => {
  await login(page, "admin.local@example.test");
  const csrfHeaders = await csrf(page);
  const currentResponse = await page.request.get("/api/admin/jima/config");
  expect(currentResponse.ok(), await currentResponse.text()).toBeTruthy();
  const original = await currentResponse.json();
  try {
    const zeroWeights = await page.request.patch("/api/admin/jima/config", {
      headers: csrfHeaders,
      data: {
        ...original,
        recommendations: {
          ...original.recommendations,
          weights: { category: 0, freshness: 0, popularity: 0 },
        },
      },
    });
    expect(zeroWeights.status()).toBe(400);

    const limited = await page.request.patch("/api/admin/jima/config", {
      headers: csrfHeaders,
      data: {
        ...original,
        recommendations: {
          ...original.recommendations,
          limit: 1,
          maxPerStore: 1,
        },
      },
    });
    expect(limited.ok(), await limited.text()).toBeTruthy();
    const visible = await page.request.get(
      "/api/ai/recommendations?placement=home",
    );
    expect(visible.ok(), await visible.text()).toBeTruthy();
    const visibleBody = await visible.json();
    expect(visibleBody).toMatchObject({ placement: "home", disabled: false });
    expect(visibleBody.items).toHaveLength(1);

    const disabledPlacement = await page.request.patch(
      "/api/admin/jima/config",
      {
        headers: csrfHeaders,
        data: {
          ...original,
          recommendations: {
            ...original.recommendations,
            limit: 1,
            placements: { ...original.recommendations.placements, home: false },
          },
        },
      },
    );
    expect(disabledPlacement.ok(), await disabledPlacement.text()).toBeTruthy();
    const hidden = await page.request.get(
      "/api/ai/recommendations?placement=home",
    );
    expect(await hidden.json()).toMatchObject({
      items: [],
      placement: "home",
      disabled: true,
    });
    const otherPlacement = await page.request.get(
      "/api/ai/recommendations?placement=product",
    );
    expect(otherPlacement.ok(), await otherPlacement.text()).toBeTruthy();
    expect((await otherPlacement.json()).disabled).toBe(false);
  } finally {
    const restored = await page.request.patch("/api/admin/jima/config", {
      headers: csrfHeaders,
      data: original,
    });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});
