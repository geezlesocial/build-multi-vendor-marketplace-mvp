import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/npm-audit-policy.mjs <npm-audit-json>');
const report = JSON.parse(await readFile(file, 'utf8'));
if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) {
  console.error('Production dependency audit did not return a valid machine-readable report.');
  process.exit(1);
}

const counts = report.metadata.vulnerabilities;
console.log(`Production npm audit: ${counts.total} total (${counts.high} high, ${counts.critical} critical).`);
const blocked = Object.entries(report.vulnerabilities).filter(([, finding]) => ['high', 'critical'].includes(finding.severity));
for (const [name, finding] of blocked) {
  const advisoryIds = finding.via.filter(item => typeof item === 'object').map(item => item.url ?? `source-${item.source}`);
  console.error(`BLOCKED ${finding.severity.toUpperCase()} ${name} ${finding.range}; advisories: ${advisoryIds.join(', ') || 'see protected audit artifact'}`);
}
assert.equal(blocked.length, 0, 'Unapproved HIGH/CRITICAL production dependency advisories block the staging workflow.');
