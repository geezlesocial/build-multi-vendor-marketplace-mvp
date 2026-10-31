import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { ClamAvScanner, MediaScannerError } from '../apps/api/dist/src/media-scanner.js';

const smtpHost = process.env.STAGING_TEST_MAILPIT_HOST ?? '127.0.0.1';
const smtpPort = Number(process.env.STAGING_TEST_MAILPIT_PORT ?? 1025);
const mailpitApi = process.env.STAGING_TEST_MAILPIT_API ?? 'http://127.0.0.1:8025';
const scannerHost = process.env.STAGING_TEST_CLAMAV_HOST ?? '127.0.0.1';
const scannerPort = Number(process.env.STAGING_TEST_CLAMAV_PORT ?? 13310);
const timeoutAt = Date.now() + 300_000;

async function waitForMailpit() {
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(`${mailpitApi}/api/v1/info`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch { /* wait for the local-only service to start */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Local Mailpit did not become ready before the smoke-test deadline.');
}

await waitForMailpit();
const subject = `staging-only-mailpit-${randomUUID()}`;
const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: false,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000
});
try {
  await transporter.verify();
  const sent = await transporter.sendMail({
    from: 'staging-check@example.test',
    to: `mailpit-capture-${randomUUID()}@example.test`,
    subject,
    text: 'Synthetic staging mail; it must be captured locally and never relayed.'
  });
  assert.ok(sent.messageId, 'Mailpit should accept the synthetic SMTP message.');
} finally {
  transporter.close();
}

let captured = false;
while (Date.now() < timeoutAt && !captured) {
  const response = await fetch(`${mailpitApi}/api/v1/messages`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, 'Mailpit capture API must stay private and reachable in the local test network.');
  const payload = await response.json();
  captured = (payload.messages ?? []).some(message => message.Subject === subject);
  if (!captured) await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(captured, 'Synthetic SMTP delivery must appear in the Mailpit capture store.');

const scanner = new ClamAvScanner(scannerHost, scannerPort, 15_000);
const clean = Buffer.from('synthetic clean staging fixture; no user media is used.');
let cleanVerdict;
while (Date.now() < timeoutAt) {
  try {
    cleanVerdict = await scanner.scan(clean);
    break;
  } catch (error) {
    if (!(error instanceof MediaScannerError) || !['SCANNER_UNAVAILABLE', 'SCANNER_TIMEOUT'].includes(error.safeCode)) throw error;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
assert.equal(cleanVerdict, 'CLEAN', 'Readiness requires a successful real clean-file scan, not just an open TCP port.');

const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii');
assert.equal(await scanner.scan(eicar), 'INFECTED', 'The standard harmless EICAR test signature must be detected.');

for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await scanner.scan(clean), 'CLEAN');
await new Promise(resolve => setTimeout(resolve, 25));
const openScannerSockets = process._getActiveHandles().filter(handle => handle instanceof net.Socket && handle.remotePort === scannerPort);
assert.equal(openScannerSockets.length, 0, 'Scanner TCP handles must be closed after each scan.');

const clamContainer = execFileSync('docker', ['compose', '-f', 'docker-compose.staging-test.yml', 'ps', '-q', 'clamav'], { encoding: 'utf8' }).trim();
assert.ok(clamContainer, 'The local ClamAV service container must exist for resource inspection.');
const memory = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', clamContainer], { encoding: 'utf8' }).trim();
assert.match(memory, /^\d+(?:\.\d+)?\s*(?:MiB|GiB)\s*\/\s*4GiB$/i, `Expected measured ClamAV usage against the configured 4-GiB limit; got: ${memory}`);
console.log(`Local integrations passed: Mailpit captured SMTP mail; ClamAV clean/EICAR scans passed; scanner sockets closed; measured container memory ${memory}.`);
