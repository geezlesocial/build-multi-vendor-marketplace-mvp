import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

if (process.argv.length < 3) throw new Error('Provide one JSON report path per scanned target.');
let blocking = false;
const summary = [];

for (const file of process.argv.slice(2)) {
  let report;
  try { report = JSON.parse(await readFile(file, 'utf8')); }
  catch { console.error(`BLOCKED: scanner report missing or invalid for ${file}.`); process.exitCode = 1; continue; }
  if (!Array.isArray(report.Results)) {
    console.error(`BLOCKED: scanner produced no Results array for ${file}.`);
    process.exitCode = 1;
    continue;
  }
  let highCritical = 0;
  let secrets = 0;
  const identifiers = new Set();
  for (const result of report.Results) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (!['HIGH', 'CRITICAL'].includes(String(vulnerability.Severity).toUpperCase())) continue;
      highCritical += 1;
      identifiers.add(`${vulnerability.Severity}:${vulnerability.VulnerabilityID ?? 'unknown'}:${vulnerability.PkgName ?? 'unknown'}`);
    }
    secrets += (result.Secrets ?? []).length;
  }
  if (highCritical || secrets) blocking = true;
  summary.push({ target: file.split(/[\\/]/).at(-1), highCritical, secrets, identifiers: [...identifiers].sort() });
}

for (const item of summary) {
  console.log(`${item.target}: ${item.highCritical} HIGH/CRITICAL vulnerabilities; ${item.secrets} secret findings${item.secrets ? ' (finding details redacted)' : ''}.`);
  for (const id of item.identifiers) console.log(`  ${id}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  const rows = summary.map(item => `| ${item.target} | ${item.highCritical} | ${item.secrets ? 'Present (details withheld)' : '0'} |`).join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Container security scan\n\n| Target | HIGH/CRITICAL | Secret findings |\n|---|---:|---|\n${rows}\n`);
}
assert.equal(blocking, false, 'HIGH/CRITICAL vulnerabilities and any secret finding block this release; unfixed issues are included.');
