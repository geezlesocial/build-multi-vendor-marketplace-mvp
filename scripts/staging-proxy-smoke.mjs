import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const baseUrl = process.env.STAGING_SMOKE_BASE_URL ?? 'http://127.0.0.1:5174';
const htmlMarker = '<div id="root">';

async function request(path, init) {
  return fetch(new URL(path, baseUrl), { redirect: 'manual', ...init });
}

const webHealth = await request('/healthz');
assert.equal(webHealth.status, 200, 'Nginx health endpoint should respond');
assert.equal((await webHealth.text()).trim(), 'ok');

const apiHealth = await request('/health');
assert.equal(apiHealth.status, 200, 'API health path must be proxied');
assert.deepEqual(await apiHealth.json(), { ok: true, service: 'marketplace-api' });

const apiMe = await request('/api/auth/me');
assert.equal(apiMe.status, 200, 'API requests must not fall through to the SPA');
assert.deepEqual(await apiMe.json(), { user: null });
const csrfSetCookie = apiMe.headers.get('set-cookie') ?? '';
assert.match(csrfSetCookie, /marketplace_csrf=/, 'Set-Cookie must survive the proxy');
assert.match(csrfSetCookie, /SameSite=Lax/i);

const noCsrf = await request('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(noCsrf.status, 403, 'CSRF must be checked before authentication');
const csrfValue = csrfSetCookie.match(/marketplace_csrf=([^;]+)/)?.[1];
assert.ok(csrfValue, 'API should issue a CSRF cookie');
const csrfChecked = await request('/api/auth/logout', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `marketplace_csrf=${csrfValue}`, 'x-csrf-token': csrfValue },
  body: '{}'
});
assert.equal(csrfChecked.status, 401, 'Matching CSRF token should pass CSRF and then require authentication');

const smokeEmail = `proxy-smoke-${Date.now()}@example.test`;
const smokePassword = randomBytes(32).toString('base64url');
const signup = await request('/api/auth/register', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: `marketplace_csrf=${csrfValue}`,
    'x-csrf-token': csrfValue,
    'x-forwarded-proto': 'https'
  },
  body: JSON.stringify({ email: smokeEmail, name: 'Proxy Smoke Test', password: smokePassword })
});
assert.equal(signup.status, 201, 'Signup should work through the same-origin proxy');
assert.equal((await signup.json()).user.email, smokeEmail);
const signupCookieHeaders = signup.headers.getSetCookie?.() ?? [signup.headers.get('set-cookie') ?? ''];
const sessionCookie = signupCookieHeaders.find(value => value.startsWith('marketplace_session=')) ?? '';
const csrfCookie = signupCookieHeaders.find(value => value.startsWith('marketplace_csrf=')) ?? '';
const sessionValue = sessionCookie.match(/marketplace_session=([^;,]+)/)?.[1];
const signupCsrf = csrfCookie.match(/marketplace_csrf=([^;,]+)/)?.[1];
assert.ok(sessionValue, 'The session cookie must survive the reverse proxy');
assert.ok(signupCsrf, 'The refreshed CSRF cookie must survive the reverse proxy');
assert.match(sessionCookie, /HttpOnly/i);
assert.match(sessionCookie, /Secure/i);

const authenticatedMe = await request('/api/auth/me', {
  headers: { cookie: `marketplace_session=${sessionValue}; marketplace_csrf=${signupCsrf}` }
});
assert.equal(authenticatedMe.status, 200);
assert.equal((await authenticatedMe.json()).user.email, smokeEmail, 'Session authentication must work through the proxy');

const logout = await request('/api/auth/logout', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: `marketplace_session=${sessionValue}; marketplace_csrf=${signupCsrf}`,
    'x-csrf-token': signupCsrf
  },
  body: '{}'
});
assert.equal(logout.status, 204, 'Authenticated logout should work through the proxy');

for (const path of ['/blog/__staging_proxy_probe__', '/pages/__staging_proxy_probe__']) {
  const response = await request(path);
  assert.equal(response.status, 404, `${path} should be handled by the API, not the SPA`);
  assert.equal((await response.text()).includes(htmlMarker), false);
}

const robots = await request('/robots.txt');
assert.equal(robots.status, 200);
assert.match(await robots.text(), /Sitemap:/);

const sitemap = await request('/sitemap.xml');
assert.equal(sitemap.status, 200);
assert.match(sitemap.headers.get('content-type') ?? '', /xml/i);
assert.match(await sitemap.text(), /<urlset/);

const spa = await request('/dashboard?tab=overview');
assert.equal(spa.status, 200, 'client-side routes should receive the React shell');
assert.equal((await spa.text()).includes(htmlMarker), true);

console.log('Staging reverse-proxy smoke checks passed.');
