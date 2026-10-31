import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Diagnostics = {
  runWithRequestContext(correlationId: string, callback: () => void): void;
  logOperationalError(event: string, error: unknown): void;
};

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../runtime/structured-logger.cjs'), resolve(here, '../../runtime/structured-logger.cjs')];
const runtimeLogger = candidates.find(existsSync);
if (!runtimeLogger) throw new Error('Structured diagnostics runtime module is missing');

export const diagnostics = createRequire(import.meta.url)(runtimeLogger) as Diagnostics;
