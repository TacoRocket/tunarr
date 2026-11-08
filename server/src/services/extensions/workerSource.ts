import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// In a native executable, only the parent can read pkg's virtual filesystem.
// Give the worker its complete program, including the WASM engine, as text.
declare const TUNARR_BUNDLED_EXTENSION_WORKER: boolean;

export async function loadExtensionWorker(): Promise<string> {
  if (typeof TUNARR_BUNDLED_EXTENSION_WORKER !== 'undefined') {
    return readFile(join(__dirname, 'extension-worker.cjs'), 'utf8');
  }
  const require = createRequire(import.meta.url);
  return `require(${JSON.stringify(require.resolve('./worker.cjs'))})`;
}
