import { expect, test, type Page } from '@playwright/test';

const password = 'LocalDemoOnly-ChangeMe-123!';
const editorEmail = 'editor.local@example.test';
const adminEmail = 'admin.local@example.test';
const buyerEmail = 'buyer.local@example.test';

async function login(page: Page, email: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function csrfHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(cookie => cookie.name === 'marketplace_csrf')?.value;
  expect(csrf).toBeTruthy();
  return { 'x-csrf-token': csrf! };
}

test('admin publishes a crawlable blog post with initial HTML metadata', async ({ page }) => {
  const slug = `cms-e2e-${Date.now()}`;
  await login(page, adminEmail);

  await page.goto('/admin/content');
  await expect(page.getByRole('heading', { name: 'Blog and pages' })).toBeVisible();
  await page.getByLabel('Title').fill('Browser CMS verification post');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Excerpt').fill('A published CMS browser verification article.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');

  const row = page.locator('.row').filter({ hasText: slug });
  await expect(row).toContainText('DRAFT');
  await row.getByRole('button', { name: 'Publish' }).click();
  await expect(row).toContainText('PUBLISHED');

  const publicPage = await page.goto(`/blog/${slug}`);
  expect(publicPage?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Browser CMS verification post' })).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'A published CMS browser verification article.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/blog/${slug}$`));
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(2);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
});

test('content editor can save drafts but cannot change indexing/navigation, and quarantined media stays private', async ({ page }) => {
  const slug = `cms-editor-${Date.now()}`;
  await login(page, editorEmail);

  await page.goto('/admin/content');
  await page.getByLabel('Title').fill('Editor draft');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Excerpt').fill('Editor-authored draft content.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');

  const createPage = await page.request.post('/api/admin/content/pages', {
    data: { title: 'Editor page', slug: `${slug}-page`, body: [{ type: 'paragraph', text: 'Editor page body.' }] },
    headers: await csrfHeaders(page)
  });
  expect(createPage.status()).toBe(201);
  const pageRecord = await createPage.json() as { id: string };
  const forbiddenNavigation = await page.request.patch(`/api/admin/content/pages/${pageRecord.id}`, {
    data: {
      title: 'Editor page',
      slug: `${slug}-page`,
      body: [{ type: 'paragraph', text: 'Editor page body.' }],
      navPlacement: 'HEADER',
      navLabel: 'Hidden editor change',
      navOrder: 1,
      noIndex: true
    },
    headers: await csrfHeaders(page)
  });
  expect(forbiddenNavigation.status()).toBe(403);

  const upload = await page.request.post('/api/admin/content/media', {
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    headers: { ...(await csrfHeaders(page)), 'content-type': 'image/png', 'x-original-name': 'quarantined.png' }
  });
  expect(upload.status()).toBe(201);
  const media = await upload.json() as { id: string; scanStatus: string };
  expect(media.scanStatus).toBe('QUARANTINED');
  const publicMedia = await page.request.get(`/content-media/${media.id}`);
  expect(publicMedia.status()).toBe(404);
});

test('buyer cannot access admin content or navigation controls', async ({ page }) => {
  await login(page, buyerEmail);
  const response = await page.request.post('/api/admin/content/pages', {
    data: {
      title: 'Unauthorized page',
      slug: `unauthorized-${Date.now()}`,
      body: [{ type: 'paragraph', text: 'This must not be created.' }],
      navPlacement: 'HEADER'
    },
    headers: await csrfHeaders(page)
  });
  expect(response.status()).toBe(403);
});
