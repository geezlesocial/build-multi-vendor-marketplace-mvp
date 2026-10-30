import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { formatJimaPrice, isAllowedJimaRuntimeUrl, JimaRuntimeSlots, JimaUserRateLimiter, requestJimaCompletion } from './jima-routes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function startOllamaFixture(handler: (request: { model: string; messages: unknown[]; think?: boolean }, response: import('node:http').ServerResponse) => void) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404).end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler(JSON.parse(body), res));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Ollama test fixture did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}

const config = (runtimeUrl: string, model = 'fixture:latest') => ({ runtimeUrl, model, temperature: 0.2, maxTokens: 80 });
const messages = [{ role: 'user' as const, content: 'Where is the catalog?' }];

describe('Jima local Ollama-compatible runtime', () => {
  it('restricts runtime URLs to plain HTTP loopback roots without credentials or URL fragments', () => {
    expect(isAllowedJimaRuntimeUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isAllowedJimaRuntimeUrl('http://localhost:11434/')).toBe(true);
    expect(isAllowedJimaRuntimeUrl('http://[::1]:11434')).toBe(true);
    expect(isAllowedJimaRuntimeUrl('https://127.0.0.1:11434')).toBe(false);
    expect(isAllowedJimaRuntimeUrl('http://localhost.evil.example')).toBe(false);
    expect(isAllowedJimaRuntimeUrl('http://user:secret@localhost:11434')).toBe(false);
    expect(isAllowedJimaRuntimeUrl('http://localhost:11434/proxy')).toBe(false);
    expect(isAllowedJimaRuntimeUrl('http://localhost:11434/?target=internal')).toBe(false);
  });

  it('formats minor-unit catalog prices using the currency exponent', () => {
    expect(formatJimaPrice(2400, 'USD')).toBe('USD 24.00');
    expect(formatJimaPrice(2400, 'JPY')).toBe('JPY 2,400');
    expect(formatJimaPrice(2400, 'not-a-currency')).toBeNull();
  });

  it('limits each user independently and releases the window after its duration', () => {
    const limiter = new JimaUserRateLimiter(2, 1000);
    expect(limiter.consume('buyer-a', 0).allowed).toBe(true);
    expect(limiter.consume('buyer-a', 1).allowed).toBe(true);
    expect(limiter.consume('buyer-a', 2)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume('buyer-b', 2).allowed).toBe(true);
    expect(limiter.consume('buyer-a', 1000).allowed).toBe(true);
  });

  it('rejects excess concurrent runtime calls and frees the slot when a call finishes', async () => {
    const slots = new JimaRuntimeSlots(1);
    let release!: () => void;
    const first = slots.run(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    await expect(slots.run(async () => 'second')).resolves.toEqual({ accepted: false });
    release();
    await expect(first).resolves.toEqual({ accepted: true, value: undefined });
    await expect(slots.run(async () => 'after')).resolves.toEqual({ accepted: true, value: 'after' });
  });

  it('sends a non-streaming chat request and returns the assistant reply', async () => {
    const runtimeUrl = await startOllamaFixture((request, response) => {
      expect(request.model).toBe('fixture:latest');
      expect(request.messages).toEqual(messages);
      expect(request.think).toBe(false);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ message: { content: 'Browse the approved catalog.' } }));
    });
    await expect(requestJimaCompletion(config(runtimeUrl), messages)).resolves.toBe('Browse the approved catalog.');
  });

  it('surfaces an unavailable model response from the local runtime', async () => {
    const runtimeUrl = await startOllamaFixture((_request, response) => response.writeHead(404).end(JSON.stringify({ error: 'model not found' })));
    await expect(requestJimaCompletion(config(runtimeUrl, 'not-installed:latest'), messages)).rejects.toThrow('HTTP 404');
  });

  it('aborts a stalled local runtime request at the configured deadline', async () => {
    const runtimeUrl = await startOllamaFixture((_request, response) => { setTimeout(() => response.writeHead(200).end(JSON.stringify({ message: { content: 'too late' } })), 250); });
    await expect(requestJimaCompletion(config(runtimeUrl), messages, 30)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
