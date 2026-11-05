import { createReadStream } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import { mkdir, rename, unlink, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from './config.js';

export interface ContentStorage {
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  open(key: string, range?: { start: number; end: number }): Readable;
  remove(key: string): Promise<void>;
}

export type DirectUploadForm = { url: string; fields: Record<string, string> };

export interface ManagedContentStorage extends ContentStorage {
  createUploadForm(key: string, contentType: string, maxBytes: number): Promise<DirectUploadForm>;
  head(key: string): Promise<{ ContentLength?: number; ContentType?: string }>;
  readLimited(key: string, maxBytes: number): Promise<{ bytes: Buffer; contentLength: number; contentType: string | null }>;
}

function safePath(key: string, storageDir = env.CONTENT_STORAGE_DIR) {
  const root = path.resolve(storageDir);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe storage path');
  return target;
}

export class LocalContentStorage implements ManagedContentStorage {
  private readonly metadata = new Map<string, { size: number; contentType: string }>();
  private readonly storageDir: string;

  constructor(storageDir = env.CONTENT_STORAGE_DIR) {
    this.storageDir = path.resolve(storageDir);
  }

  async put(key: string, bytes: Buffer, contentType = 'application/octet-stream') {
    const target = safePath(key, this.storageDir);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.uploading`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
    this.metadata.set(key, { size: bytes.length, contentType });
  }

  async createUploadForm(_key: string, _contentType: string, _maxBytes: number): Promise<DirectUploadForm> {
    throw new Error('Local storage uses the authenticated application upload endpoint.');
  }

  async head(key: string): Promise<{ ContentLength: number; ContentType: string }> {
    const file = await stat(safePath(key, this.storageDir));
    return {
      ContentLength: file.size,
      ContentType: this.metadata.get(key)?.contentType ?? 'application/octet-stream',
    };
  }

  async readLimited(key: string, maxBytes: number) {
    const target = safePath(key, this.storageDir);
    const file = await stat(target);
    if (file.size > maxBytes) throw new Error('Uploaded object exceeded its reserved size');
    const bytes = await readFile(target);
    if (bytes.length > maxBytes) throw new Error('Uploaded object exceeded its reserved size');
    const metadata = this.metadata.get(key);
    return { bytes, contentLength: bytes.length, contentType: metadata?.contentType ?? null };
  }

  open(key: string, range?: { start: number; end: number }) { return createReadStream(safePath(key, this.storageDir), range); }

  async remove(key: string) {
    try { await unlink(safePath(key, this.storageDir)); this.metadata.delete(key); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export class S3ContentStorage implements ContentStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options?: { client: S3Client; bucket: string }) {
    this.client = options?.client ?? new S3Client({ region: env.CONTENT_OBJECT_STORAGE_REGION!, ...(env.CONTENT_OBJECT_STORAGE_ENDPOINT ? { endpoint: env.CONTENT_OBJECT_STORAGE_ENDPOINT, forcePathStyle: true } : {}) });
    this.bucket = options?.bucket ?? env.CONTENT_OBJECT_STORAGE_BUCKET!;
  }

  async createUploadForm(key: string, contentType: string, maxBytes: number): Promise<DirectUploadForm> {
    return createPresignedPost(this.client, { Bucket: this.bucket, Key: key, Expires: 300, Fields: { 'Content-Type': contentType, success_action_status: '201' }, Conditions: [['eq', '$Content-Type', contentType], ['content-length-range', 1, maxBytes], ['eq', '$success_action_status', '201']] });
  }

  async readLimited(key: string, maxBytes: number) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error('Uploaded object is unavailable');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) throw new Error('Uploaded object exceeded its reserved size');
      chunks.push(bytes);
    }
    return { bytes: Buffer.concat(chunks), contentLength: response.ContentLength ?? total, contentType: response.ContentType ?? null };
  }

  async head(key: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async put(key: string, bytes: Buffer, contentType = 'application/octet-stream') {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'private, no-store' }));
  }

  open(key: string, range?: { start: number; end: number }) {
    const output = new PassThrough();
    this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) })).then(response => {
      const body = response.Body as Readable | undefined;
      if (!body) return output.destroy(new Error('Object body is missing'));
      body.on('error', error => output.destroy(error));
      body.pipe(output);
    }).catch(error => output.destroy(error instanceof Error ? error : new Error('Object unavailable')));
    return output;
  }

  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export const localContentStorage = new LocalContentStorage();
export const objectContentStorage = env.CONTENT_OBJECT_STORAGE_AVAILABLE ? new S3ContentStorage() : null;
export const contentStorage: ContentStorage = localContentStorage;

export function openContentObject(storageProvider: 'LOCAL' | 'OBJECT', key: string, range?: { start: number; end: number }) {
  if (storageProvider === 'LOCAL') return localContentStorage.open(key, range);
  if (!objectContentStorage) throw new Error('Managed object storage is not available');
  return objectContentStorage.open(key, range);
}
