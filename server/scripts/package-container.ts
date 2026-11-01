import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkWebVersion } from '../../scripts/check-web-version.mjs';
import { grabEtvNext } from './download-ersatztv-next.ts';
import { grabMeilisearch } from './download-meilisearch.ts';

// The backend imports migration definitions even when invoked with --version.
await fs.cp('./src/migration/db/sql', './dist/sql', { recursive: true });

const backendVersion = execFileSync(
  'bun',
  [path.resolve('dist/bundle.cjs'), '--version'],
  { encoding: 'utf8', timeout: 30_000 },
).trim();
checkWebVersion(path.resolve('../web/dist'), backendVersion);

await fs.cp(path.resolve('../web/dist'), './dist/web', { recursive: true });

const searchBinary = await grabMeilisearch('./bin/meilisearch');
if (!searchBinary) {
  throw new Error('Could not package Meilisearch');
}

// The opt-in ErsatzTV next backend; the download refuses an archive off its pinned SHA-256.
const etvNextBinary = await grabEtvNext('./bin/ersatztv-channel');
if (!etvNextBinary) {
  throw new Error('Could not package the ErsatzTV next worker');
}

console.log(
  'Container bundle, native SQLite package, Meilisearch and the ErsatzTV next worker are ready.',
);
