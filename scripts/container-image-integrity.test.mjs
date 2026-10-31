import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [lock, apiDockerfile, webDockerfile] = await Promise.all([
  readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../apps/api/Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../apps/web/Dockerfile', import.meta.url), 'utf8')
]);

const resolved = [];
for (const [name, item] of Object.entries(lock.packages ?? {})) {
  if (item.link || !item.resolved || !item.resolved.startsWith('https://')) continue;
  assert.ok(item.integrity, `${name || 'root package'} has no lockfile integrity hash`);
  assert.match(item.resolved, /^https:\/\/registry\.npmjs\.org\//, `${name} must resolve from the locked official npm registry URL`);
  resolved.push(name);
}
assert.ok(resolved.length > 400, 'Expected a complete integrity-locked npm dependency graph.');
assert.doesNotMatch(apiDockerfile + webDockerfile, /registry\.npmmirror\.com/);
assert.match(apiDockerfile, /COPY packages\/migrator\/package\.json packages\/migrator\/package\.json/);
assert.match(webDockerfile, /COPY packages\/migrator\/package\.json packages\/migrator\/package\.json/);

for (const [file, content] of [['apps/api/Dockerfile', apiDockerfile], ['apps/web/Dockerfile', webDockerfile]]) {
  const fromLines = content.split(/\r?\n/).filter(line => /^FROM\s+/i.test(line));
  assert.ok(fromLines.length > 0, `${file} must define a build image`);
  const buildStages = new Set(fromLines.map(line => line.match(/\sAS\s+(\S+)/i)?.[1]?.toLowerCase()).filter(Boolean));
  for (const line of fromLines) {
    const image = line.replace(/^FROM\s+/i, '').split(/\s+/)[0].toLowerCase();
    if (buildStages.has(image)) continue;
    assert.match(line, /@sha256:[a-f0-9]{64}/i, `${file} base image must be pinned by digest: ${line}`);
  }
}
console.log(`Container provenance inputs passed: ${resolved.length} registry packages have integrity hashes; every base image is digest-pinned.`);
