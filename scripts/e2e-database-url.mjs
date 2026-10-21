const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function validateE2EBaseURL(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('E2E_BASE_URL is required for isolated browser tests');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('E2E_BASE_URL must be a valid local HTTP URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('E2E_BASE_URL must use HTTP or HTTPS');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!localHosts.has(hostname)) {
    throw new Error('E2E_BASE_URL must target a local disposable test server');
  }

  if (parsed.username || parsed.password) {
    throw new Error('E2E_BASE_URL must not contain credentials');
  }

  return { hostname, value };
}

export function validateE2EDatabaseURL(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('E2E_DATABASE_URL is required for isolated browser tests');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('E2E_DATABASE_URL must use the postgres or postgresql protocol');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!localHosts.has(hostname)) {
    throw new Error('E2E_DATABASE_URL must target a local disposable database host');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('E2E_DATABASE_URL contains an invalid database name');
  }

  if (!databaseName || databaseName.includes('/') || !/(e2e|test)/i.test(databaseName)) {
    throw new Error('E2E_DATABASE_URL database name must include e2e or test');
  }

  return { databaseName, hostname, value };
}
