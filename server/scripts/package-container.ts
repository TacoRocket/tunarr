import fs from 'node:fs/promises';
import path from 'node:path';
import { grabMeilisearch } from './download-meilisearch.ts';

await fs.cp(path.resolve('../web/dist'), './dist/web', { recursive: true });
await fs.cp('./src/migration/db/sql', './dist/sql', { recursive: true });

const searchBinary = await grabMeilisearch('./bin/meilisearch');
if (!searchBinary) {
  throw new Error('Could not package Meilisearch');
}

console.log(
  'Container bundle, native SQLite package and Meilisearch are ready.',
);
