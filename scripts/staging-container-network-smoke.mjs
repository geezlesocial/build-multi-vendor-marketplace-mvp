import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const composeFile = 'docker-compose.staging-test.yml';
const smokeId = randomUUID();
const containerProbe = String.raw`
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { ClamAvScanner } from '/workspace/apps/api/dist/src/media-scanner.js';

const identity = process.env.STAGING_CONTAINER_SMOKE_ID;
assert.match(identity ?? '', /^[0-9a-f-]{36}$/i, 'unique synthetic smoke identity is required');

const mailpit = nodemailer.createTransport({
  host: process.env.STORE_EMAIL_SMTP_HOST,
  port: Number(process.env.STORE_EMAIL_SMTP_PORT),
  secure: false,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000
});
try {
  await mailpit.verify();
  const subject = 'api-container-mailpit-' + identity;
  await mailpit.sendMail({ from: process.env.STORE_EMAIL_FROM, to: 'synthetic-' + identity + '@example.test', subject, text: 'Local-only container network verification.' });
  let captured = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !captured) {
    const response = await fetch('http://mailpit:8025/api/v1/messages', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200, 'Mailpit capture API must be reachable from the API container');
    const payload = await response.json();
    captured = (payload.messages ?? []).some(message => message.Subject === subject);
    if (!captured) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(captured, 'API container SMTP message must be visible in Mailpit');
} finally {
  mailpit.close();
}

const scanner = new ClamAvScanner(process.env.CONTENT_SCANNER_HOST, Number(process.env.CONTENT_SCANNER_PORT), 15000);
const clean = Buffer.from('synthetic clean content; local integration fixture.');
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii');
const deadline = Date.now() + 300000;
let cleanVerdict;
while (Date.now() < deadline) {
  try {
    cleanVerdict = await scanner.scan(clean);
    break;
  } catch (error) {
    if (!['SCANNER_UNAVAILABLE', 'SCANNER_TIMEOUT'].includes(error?.safeCode)) throw error;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
assert.equal(cleanVerdict, 'CLEAN', 'API image must reach ClamAV and receive a clean verdict');
assert.equal(await scanner.scan(eicar), 'INFECTED', 'API image must receive an infected verdict for the harmless EICAR test string');
console.log('API-container network checks passed: synthetic SMTP was captured by Mailpit; production ClamAV adapter returned CLEAN and INFECTED.');
`;

execFileSync('docker', [
  'compose', '-f', composeFile, 'exec', '-T', '-e', `STAGING_CONTAINER_SMOKE_ID=${smokeId}`,
  'api', 'node', '--input-type=module', '-e', containerProbe
], { stdio: 'inherit', env: process.env });

console.log('Container dependency smoke completed with synthetic data only.');
