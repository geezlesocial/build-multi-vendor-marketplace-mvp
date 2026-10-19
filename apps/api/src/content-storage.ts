import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './config.js';

export interface ContentStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  open(key: string): ReturnType<typeof createReadStream>;
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
}

export const contentStorage = new LocalContentStorage();
