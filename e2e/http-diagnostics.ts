import type { APIResponse, Page } from '@playwright/test';

const observedPages = new WeakSet<Page>();

/** Log only non-sensitive rate-limit metadata when the browser receives HTTP 429. */
export function logRateLimitResponses(page: Page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.on('response', response => {
    if (response.status() !== 429) return;
    const headers = response.headers();
    const path = new URL(response.url()).pathname;
    console.warn('[e2e-http-429]', JSON.stringify({
      method: response.request().method(),
      path,
      policy: headers['ratelimit-policy'] ?? null,
      limit: headers['ratelimit-limit'] ?? null,
      remaining: headers['ratelimit-remaining'] ?? null,
      reset: headers['ratelimit-reset'] ?? null
    }));
  });
}

export function rateLimitFailureDetails(response: APIResponse) {
  const headers = response.headers();
  return `RateLimit-Policy=${headers['ratelimit-policy'] ?? 'not supplied'}, RateLimit-Remaining=${headers['ratelimit-remaining'] ?? 'not supplied'}`;
}
