import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalContentStorage, S3ContentStorage } from './content-storage.js';

describe('local private media storage', () => {
  let root = '';
  let storage: LocalContentStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'marketplace-content-storage-'));
    storage = new LocalContentStorage(root);
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('stores, bounds, reads, and removes local upload objects', async () => {
    const bytes = Buffer.from('private image fixture');
    await storage.put('stores/store-1/pending/asset-1', bytes, 'image/png');
    await expect(storage.head('stores/store-1/pending/asset-1')).resolves.toEqual({ ContentLength: bytes.length, ContentType: 'image/png' });
    await expect(storage.readLimited('stores/store-1/pending/asset-1', bytes.length)).resolves.toMatchObject({ bytes, contentLength: bytes.length, contentType: 'image/png' });
    await expect(storage.readLimited('stores/store-1/pending/asset-1', bytes.length - 1)).rejects.toThrow('Uploaded object exceeded its reserved size');
    await storage.remove('stores/store-1/pending/asset-1');
    await expect(storage.head('stores/store-1/pending/asset-1')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects path traversal outside its configured local directory', async () => {
    await expect(storage.put('../outside', Buffer.from('unsafe'))).rejects.toThrow('Unsafe storage path');
  });
});

describe('S3-compatible managed media storage (loopback protocol fixture)', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = '';
  let storage: S3ContentStorage;
  let client: S3Client;
  let lastRequest: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer } | null;

  beforeEach(async () => {
    lastRequest = null;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        lastRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': '4', 'Content-Type': 'application/octet-stream' }).end();
        } else if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Length': '4', 'Content-Type': 'application/octet-stream' }).end('data');
        } else if (req.method === 'PUT') {
          res.writeHead(200, { ETag: '"fixture-etag"' }).end();
        } else if (req.method === 'DELETE') {
          res.writeHead(204).end();
        } else {
          res.writeHead(405).end();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('S3 fixture did not bind a loopback TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new S3Client({
      region: 'us-east-1', endpoint: baseUrl, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key' }
    });
    storage = new S3ContentStorage({
      bucket: 'private-media-fixture',
      client
    });
  });

  afterEach(async () => {
    client?.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('issues a short-lived object-scoped POST policy with fixed type and bounded size', async () => {
    const upload = await storage.createUploadForm('pending/store/asset-1', 'image/png', 4096);
    const encodedPolicy = upload.fields.Policy;
    if (!encodedPolicy) throw new Error('S3 upload form did not include its signed policy');
    const policy = JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
    const expiresInMs = Date.parse(policy.expiration) - Date.now();
    expect(new URL(upload.url).origin).toBe(baseUrl);
    expect(upload.fields.key).toBe('pending/store/asset-1');
    expect(upload.fields['Content-Type']).toBe('image/png');
    expect(upload.fields.success_action_status).toBe('201');
    expect(expiresInMs).toBeGreaterThan(4 * 60_000);
    expect(expiresInMs).toBeLessThanOrEqual(5 * 60_000);
    expect(policy.conditions).toContainEqual({ key: 'pending/store/asset-1' });
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png']);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 4096]);
    expect(lastRequest).toBeNull();
  });

  it('scopes metadata and object operations to the configured bucket and key', async () => {
    await expect(storage.head('quarantine/asset-2')).resolves.toMatchObject({ ContentLength: 4, ContentType: 'application/octet-stream' });
    expect(lastRequest?.method).toBe('HEAD');
    expect(new URL(lastRequest!.url, baseUrl).pathname).toBe('/private-media-fixture/quarantine/asset-2');

    await expect(storage.readLimited('quarantine/asset-2', 4)).resolves.toMatchObject({ bytes: Buffer.from('data'), contentLength: 4, contentType: 'application/octet-stream' });
    expect(lastRequest?.method).toBe('GET');
    expect(new URL(lastRequest!.url, baseUrl).pathname).toBe('/private-media-fixture/quarantine/asset-2');

    await storage.put('approved/asset-2.webp', Buffer.from('safe'), 'image/webp');
    expect(lastRequest?.method).toBe('PUT');
    expect(new URL(lastRequest!.url, baseUrl).pathname).toBe('/private-media-fixture/approved/asset-2.webp');
    expect(lastRequest?.body).toEqual(Buffer.from('safe'));
    expect(lastRequest?.headers['cache-control']).toBe('private, no-store');
    expect(lastRequest?.headers['content-type']).toBe('image/webp');

    const chunks: Buffer[] = [];
    for await (const chunk of storage.open('approved/asset-2.webp')) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('data'));
    await storage.remove('approved/asset-2.webp');
    expect(lastRequest?.method).toBe('DELETE');
    expect(new URL(lastRequest!.url, baseUrl).pathname).toBe('/private-media-fixture/approved/asset-2.webp');
  });

  it('rejects an object exceeding the server-side read bound', async () => {
    await expect(storage.readLimited('quarantine/asset-3', 3)).rejects.toThrow('Uploaded object exceeded its reserved size');
  });
});
