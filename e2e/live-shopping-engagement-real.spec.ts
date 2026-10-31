import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestPrismaClient } from '../scripts/prisma-test-client.mjs';
import { validateE2EDatabaseURL } from '../scripts/e2e-database-url.mjs';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required; live engagement integration tests must use the disposable E2E database.');
validateE2EDatabaseURL(databaseUrl);
const prisma = createTestPrismaClient(databaseUrl);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${Number(process.env.E2E_WEB_PORT ?? 5173)}`;
const simulatorEnabled = process.env.E2E_LIVE_SHOPPING_SIMULATOR === 'true';

test.afterAll(async () => prisma.$disconnect());

async function loginAs(page: Page, email: string) {
  await page.request.get('/api/auth/me');
  const login = await page.request.post('/api/auth/login', { data: { email, password: 'LocalDemoOnly-ChangeMe-123!' } });
  expect(login.status(), await login.text()).toBe(200);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  return { csrf: csrf!, userId: ((await me.json()) as { user: { id: string } }).user.id };
}

async function openViewer(browser: Browser, email: string, sessionId: string, blockSse = false) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const auth = await loginAs(page, email);
  if (blockSse) await context.route(`**/api/live-sessions/${sessionId}/engagement/events`, route => route.abort());
  await page.goto(`/live/${encodeURIComponent(sessionId)}`);
  await expect(page.getByRole('button', { name: /^Like,/ })).toBeVisible({ timeout: 15_000 });
  return { context, page, ...auth };
}

async function waitForProbe(page: Page, reaction: string, expectedCount: number) {
  await expect.poll(() => page.evaluate(({ reaction: key, expected }) => {
    const probe = (window as Window & { __liveEngagementProbe?: { events: { counts: Record<string, number> }[] } }).__liveEngagementProbe;
    return probe?.events.some(event => event.counts[key] === expected) ?? false;
  }, { reaction, expected: expectedCount }), { timeout: 8_000, intervals: [250, 500, 1_000] }).toBe(true);
}

test('two authenticated viewers synchronize persisted reactions over SSE, reconnect, and polling fallback', async ({ browser }) => {
  test.skip(!simulatorEnabled, 'Run with the local-only LiveKit simulator and a per-run disposable wallet_funding_e2e database.');
  test.setTimeout(90_000);

  const seller = await prisma.seller.findFirst({ where: { status: 'APPROVED' }, select: { id: true } });
  const buyer = await prisma.user.findUnique({ where: { email: 'buyer.local@example.test' }, select: { id: true } });
  const admin = await prisma.user.findUnique({ where: { email: 'admin.local@example.test' }, select: { id: true } });
  expect(seller).toBeTruthy();
  expect(buyer).toBeTruthy();
  expect(admin).toBeTruthy();

  // Recover safely from an interrupted prior attempt in this same disposable DB.
  await prisma.liveSession.deleteMany({ where: { title: 'Disposable engagement synchronization test' } });
  await prisma.marketplaceSettings.updateMany({ where: { id: 'default' }, data: { liveShoppingEnabled: false } });
  const sessionId = `c${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await prisma.marketplaceSettings.upsert({ where: { id: 'default' }, update: { liveShoppingEnabled: true }, create: { id: 'default', multiVendorEnabled: true, liveShoppingEnabled: true } });
  await prisma.liveSession.create({ data: {
    id: sessionId,
    sellerId: seller!.id,
    title: 'Disposable engagement synchronization test',
    timezone: 'UTC',
    status: 'LIVE',
    provider: 'LIVEKIT',
    providerSessionRef: `marketplace-live-e2e-${randomUUID()}`,
    playbackRef: `marketplace-live-e2e-${randomUUID()}`,
    startedAt: new Date()
  } });

  let viewerA: Awaited<ReturnType<typeof openViewer>> | undefined;
  let viewerB: Awaited<ReturnType<typeof openViewer>> | undefined;
  let guestContext: BrowserContext | undefined;
  let guestPage: Page | undefined;
  try {
    viewerA = await openViewer(browser, 'buyer.local@example.test', sessionId);
    viewerB = await openViewer(browser, 'admin.local@example.test', sessionId, true);
    expect(viewerA.userId).not.toBe(viewerB.userId);

    const mutate = (viewer: NonNullable<typeof viewerA>, reaction: string | null) => viewer.page.request.put(`/api/live-sessions/${sessionId}/reaction`, {
      headers: { 'x-csrf-token': viewer.csrf },
      data: { reaction }
    });

    const probeStarted = await viewerA.page.evaluate(id => {
      const target = window as Window & { __liveEngagementProbe?: { ready: boolean; events: { counts: Record<string, number> }[]; source: EventSource } };
      const probe = { ready: false, events: [] as { counts: Record<string, number> }[], source: new EventSource(`/api/live-sessions/${encodeURIComponent(id)}/engagement/events`, { withCredentials: true }) };
      probe.source.addEventListener('ready', () => { probe.ready = true; });
      probe.source.addEventListener('engagement', event => {
        try { probe.events.push(JSON.parse((event as MessageEvent<string>).data) as { counts: Record<string, number> }); } catch { /* invalid data is ignored by the app too */ }
      });
      target.__liveEngagementProbe = probe;
      return true;
    }, sessionId);
    expect(probeStarted).toBe(true);
    await expect.poll(() => viewerA!.page.evaluate(() => (window as Window & { __liveEngagementProbe?: { ready: boolean } }).__liveEngagementProbe?.ready ?? false), { timeout: 5_000 }).toBe(true);

    await viewerA.page.getByRole('button', { name: /^Love,/ }).click();
    await expect(viewerA.page.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await prisma.liveSessionReaction.findUnique({ where: { sessionId_userId: { sessionId, userId: viewerA!.userId } }, select: { reaction: true } }))?.reaction ?? null).toBe('LOVE');
    await waitForProbe(viewerA.page, 'LOVE', 1);

    const second = await mutate(viewerB, 'HAPPY');
    expect(second.status()).toBe(200);
    await expect(viewerA.page.getByRole('button', { name: 'Happy, 1' })).toHaveAttribute('aria-pressed', 'false');
    await waitForProbe(viewerA.page, 'HAPPY', 1);
    await expect(viewerB.page.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

    const switched = await mutate(viewerA, 'SMILE');
    expect(switched.status()).toBe(200);
    const switchedBody = await switched.json() as { reactions: Record<string, number>; myReaction: string | null };
    expect(switchedBody).toMatchObject({ myReaction: 'SMILE', reactions: { LOVE: 0, HAPPY: 1, SMILE: 1 } });
    await waitForProbe(viewerA.page, 'SMILE', 1);

    await viewerA.page.evaluate(id => {
      const target = window as Window & { __liveEngagementProbe?: { ready: boolean; events: { counts: Record<string, number> }[]; source: EventSource } };
      target.__liveEngagementProbe?.source.close();
      const probe = { ready: false, events: [] as { counts: Record<string, number> }[], source: new EventSource(`/api/live-sessions/${encodeURIComponent(id)}/engagement/events`, { withCredentials: true }) };
      probe.source.addEventListener('ready', () => { probe.ready = true; });
      probe.source.addEventListener('engagement', event => {
        try { probe.events.push(JSON.parse((event as MessageEvent<string>).data) as { counts: Record<string, number> }); } catch { /* Ignore malformed test payloads. */ }
      });
      target.__liveEngagementProbe = probe;
    }, sessionId);
    await expect.poll(() => viewerA!.page.evaluate(() => (window as Window & { __liveEngagementProbe?: { ready: boolean } }).__liveEngagementProbe?.ready ?? false), { timeout: 5_000 }).toBe(true);
    const removed = await mutate(viewerB, null);
    expect(removed.status()).toBe(200);
    await waitForProbe(viewerA.page, 'HAPPY', 0);
    await expect(viewerA.page.getByRole('button', { name: 'Happy, 0' })).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });

    const guest = await browser.newContext({ baseURL });
    guestContext = guest;
    guestPage = await guest.newPage();
    await guestPage.request.get('/api/auth/me');
    const guestCsrf = (await guest.cookies()).find(cookie => cookie.name === 'marketplace_csrf')?.value;
    expect(guestCsrf).toBeTruthy();
    const guestMutation = await guestPage.request.put(`/api/live-sessions/${sessionId}/reaction`, { headers: { 'x-csrf-token': guestCsrf! }, data: { reaction: 'LIKE' } });
    expect(guestMutation.status()).toBe(401);

    // Viewer B's EventSource is deliberately aborted. The UI's 10-second DB poll
    // must still render Viewer A's latest reaction without relying on SSE.
    const lastSwitch = await mutate(viewerA, 'CONGRATS');
    expect(lastSwitch.status()).toBe(200);
    await expect(viewerB.page.getByRole('button', { name: 'Congrats, 1' })).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

    const final = await viewerB.page.request.get(`/api/live-sessions/${sessionId}/engagement`);
    const finalBody = await final.json() as { reactions: Record<string, number>; viewCount: number; myReaction: string | null };
    expect(finalBody).toMatchObject({ myReaction: null, reactions: { LOVE: 0, HAPPY: 0, SMILE: 0, CONGRATS: 1 }, viewCount: 0 });
    expect(await prisma.liveSessionAttendance.count({ where: { sessionId } })).toBe(0);
    expect(await prisma.liveSessionView.count({ where: { sessionId } })).toBe(0);

    const repost = await viewerA.page.request.post(`/api/live-sessions/${sessionId}/repost`, { headers: { 'x-csrf-token': viewerA.csrf } });
    expect(repost.status()).toBe(200);
    expect(await repost.json()).toMatchObject({ reposted: true, repostCount: 1 });
    const duplicateRepost = await viewerA.page.request.post(`/api/live-sessions/${sessionId}/repost`, { headers: { 'x-csrf-token': viewerA.csrf } });
    expect(duplicateRepost.status()).toBe(200);
    expect(await duplicateRepost.json()).toMatchObject({ reposted: true, repostCount: 1 });
    expect(await prisma.liveSessionRepost.count({ where: { sessionId, userId: viewerA.userId } })).toBe(1);
    expect(await (await viewerA.page.request.get(`/api/account/live-reposts`)).json()).toHaveLength(1);
    expect(await (await viewerB.page.request.get(`/api/account/live-reposts`)).json()).toHaveLength(0);
    expect(await (await viewerA.page.request.get(`/api/live-sessions/${sessionId}/social`)).json()).toMatchObject({ reposted: true, repostCount: 1 });
    expect(await (await viewerB.page.request.get(`/api/live-sessions/${sessionId}/social`)).json()).toMatchObject({ reposted: false, repostCount: 1 });

    const guestSocialResponse = await guestPage.request.get(`/api/live-sessions/${sessionId}/social`);
    expect(guestSocialResponse.status()).toBe(200);
    const guestSocial = await guestSocialResponse.json() as Record<string, unknown>;
    expect(guestSocial).toMatchObject({ reposted: false, repostCount: 1 });
    expect(guestSocial).not.toHaveProperty('userId');
    const unrepost = await viewerA.page.request.delete(`/api/live-sessions/${sessionId}/repost`, { headers: { 'x-csrf-token': viewerA.csrf } });
    expect(unrepost.status()).toBe(200);
    expect(await unrepost.json()).toMatchObject({ reposted: false, repostCount: 0 });
    expect(await (await viewerA.page.request.get(`/api/account/live-reposts`)).json()).toHaveLength(0);
  } finally {
    await guestContext?.close().catch(() => undefined);
    await viewerA?.context.close().catch(() => undefined);
    await viewerB?.context.close().catch(() => undefined);
    await prisma.liveSession.deleteMany({ where: { id: sessionId } });
    await prisma.marketplaceSettings.updateMany({ where: { id: 'default' }, data: { liveShoppingEnabled: false } });
  }
});
