import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkWebVersion } from '../../scripts/check-web-version.mjs';
import { grabMeilisearch } from './download-meilisearch.ts';

const backendVersion = execFileSync(
  'bun',
  [path.resolve('dist/bundle.cjs'), '--version'],
  { encoding: 'utf8', timeout: 30_000 },
).trim();
checkWebVersion(path.resolve('../web/dist'), backendVersion);

await fs.cp(path.resolve('../web/dist'), './dist/web', { recursive: true });
await fs.cp('./src/migration/db/sql', './dist/sql', { recursive: true });

const searchBinary = await grabMeilisearch('./bin/meilisearch');
if (!searchBinary) {
  throw new Error('Could not package Meilisearch');
}

console.log(
  'Container bundle, native SQLite package and Meilisearch are ready.',
);
