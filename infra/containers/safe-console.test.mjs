import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../../apps/api/runtime', import.meta.url));
const logger = `${runtime}/structured-logger.cjs`;
const preload = `${runtime}/safe-console.cjs`;
const correlationId = '3dd3750f-703a-4f88-bf18-75ea495d137e';
const child = spawnSync(process.execPath, [
  '-e', `const d=require(${JSON.stringify(logger)}); d.runWithRequestContext(${JSON.stringify(correlationId)},()=>{ console.error('HTTP_REQUEST_FAILED', new Error('DATABASE_URL=postgresql://private:token@host/db')); d.logOperationalError('CONTENT_SCHEDULER_FAILED', new Error('SMTP_PASSWORD=secret')); }); console.warn('provider warning access_token=hidden'); console.log('boot complete password=hidden');`
], { env: { ...process.env, NODE_OPTIONS: `--require=${preload}` }, encoding: 'utf8' });

assert.equal(child.status, 0, child.stderr);
const combined = `${child.stdout}\n${child.stderr}`;
assert.doesNotMatch(combined, /private:token|SMTP_PASSWORD=secret|access_token=hidden|password=hidden/);
const records = combined.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
assert.ok(records.some(record => record.event === 'HTTP_REQUEST_FAILED' && record.correlationId === correlationId));
assert.ok(records.some(record => record.event === 'CONTENT_SCHEDULER_FAILED' && record.errorCategory === 'APPLICATION_ERROR'));
assert.ok(records.some(record => record.level === 'warn' && record.event === 'APPLICATION_WARNING'));
assert.ok(records.some(record => record.level === 'info' && record.event === 'APPLICATION_EVENT'));
console.log('Structured safe diagnostics checks passed.');
