import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import z from 'zod';
import type { LineupRepository } from '../../db/channel/LineupRepository.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { getProgramReferences } from '../ProgramReferences.ts';

const Manifest = z.object({
  version: z.literal(1),
  programId: z.string(),
  identity: z.string(),
});
const ManifestSuffix = '.source.json';

/** Local identity needs no media read. Remote changes become visible on a scan. */
export async function subtitleSourceIdentity(
  source: { type: string; path: string },
  revision?: string | null,
): Promise<string> {
  let identity: unknown;
  if (source.type === 'file') {
    const stat = await fs.stat(source.path);
    identity = [source.path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
  } else {
    identity = [source.path.split('?')[0], revision];
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
}

export async function hasSubtitleCache(file: string, identity?: string) {
  if (!identity) return false;
  const manifest = await readManifest(file + ManifestSuffix);
  if (manifest?.identity !== identity) return false;
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function recordSubtitleCache(
  file: string,
  programId: string,
  identity: string,
) {
  // The subtitle itself is published first. A missing manifest is a cache miss.
  await fs.writeFile(
    file + ManifestSuffix,
    JSON.stringify({ version: 1, programId, identity }),
  );
}

async function readManifest(file: string) {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  // Interrupted metadata writes must never make an unverified subtitle usable.
  try {
    const parsed = Manifest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Own only manifested extractions; external sidecars have a separate lifecycle. */
export async function sweepSubtitleCache(
  folder: string,
  db: DrizzleDBAccess,
  lineups: LineupRepository,
) {
  let entries: string[];
  try {
    entries = await fs.readdir(folder, { recursive: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const references = await getProgramReferences(db, lineups);
  const states = new Map(
    db
      .all<{
        id: string;
        state: string;
      }>(sql`SELECT uuid AS id, state FROM program`)
      .map((p) => [p.id, p.state]),
  );
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(ManifestSuffix)) continue;
    const manifestPath = path.join(folder, entry);
    const manifest = await readManifest(manifestPath);
    if (!manifest || references.has(manifest.programId)) continue;
    const state = states.get(manifest.programId);
    // Preserve missing items until trash repair or explicit removal resolves them.
    if (state !== undefined && state !== 'ok') continue;
    await fs.rm(manifestPath.slice(0, -ManifestSuffix.length), { force: true });
    await fs.rm(manifestPath, { force: true });
    removed++;
  }
  return removed;
}

export async function retireReplacedSubtitleCache(
  folder: string,
  programId: string,
  identity: string,
) {
  for (const entry of await fs.readdir(folder, { recursive: true })) {
    if (!entry.endsWith(ManifestSuffix)) continue;
    const manifestPath = path.join(folder, entry);
    const manifest = await readManifest(manifestPath);
    if (manifest?.programId !== programId || manifest.identity === identity)
      continue;
    await fs.rm(manifestPath.slice(0, -ManifestSuffix.length), { force: true });
    await fs.rm(manifestPath, { force: true });
  }
}
