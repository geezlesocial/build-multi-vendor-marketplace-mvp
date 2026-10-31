import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('../../apps/api/runtime/safe-console.cjs', import.meta.url));
const child = spawnSync(process.execPath, [
  '--require', preload,
  '-e', "console.error('provider failed: sk_live_sensitive-token'); console.error('Reference exchange-rate refresh failed', new Error('private-url?secret=value')); console.log('boot complete with secret=hidden');"
], { encoding: 'utf8' });

assert.equal(child.status, 0, child.stderr);
assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /sk_live_sensitive-token|private-url|secret=value|secret=hidden/);
assert.match(child.stderr, /Unhandled application error \(details redacted\)/);
assert.match(child.stderr, /Reference exchange-rate refresh failed/);
assert.match(child.stdout, /Application event \(details redacted\)/);
console.log('Staging safe-console redaction checks passed.');
