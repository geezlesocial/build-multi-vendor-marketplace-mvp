import { createReadStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './config.js';

export interface ContentStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  open(key: string): ReturnType<typeof createReadStream>;
  remove(key: string): Promise<void>;
}

function safePath(key: string) {
  const root = path.resolve(env.CONTENT_STORAGE_DIR);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe storage path');
  return target;
}

export class LocalContentStorage implements ContentStorage {
  async put(key: string, bytes: Buffer) {
    const target = safePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.uploading`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  }

  open(key: string) { return createReadStream(safePath(key)); }

  async remove(key: string) {
    try { await unlink(safePath(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export const contentStorage = new LocalContentStorage();
