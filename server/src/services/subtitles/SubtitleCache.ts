import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import z from 'zod';
import type { LineupRepository } from '../../db/channel/LineupRepository.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { getProgramReferences } from '../ProgramReferences.ts';
import { acquiredSubtitleDirectory } from '../../util/subtitles.ts';
import { sweepPgsTemporaryDirectories } from './PgsOcrProcess.ts';

const AcquisitionDetails = {
  language: z.string(),
  forced: z.boolean(),
  sdh: z.boolean(),
};
const Acquisition = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('plex'),
    title: z.string().optional(),
    ...AcquisitionDetails,
  }),
  z.object({
    provider: z.literal('pgs-ocr'),
    ...AcquisitionDetails,
    streamIndex: z.number().int().nonnegative(),
    recipeVersion: z.literal(1),
  }),
]);
export type SubtitleAcquisition = z.infer<typeof Acquisition>;

const Manifest = z.object({
  version: z.literal(1),
  programId: z.string(),
  identity: z.string(),
  acquisition: Acquisition.optional(),
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
  acquisition?: SubtitleAcquisition,
) {
  // The subtitle itself is published first. A missing manifest is a cache miss.
  await fs.writeFile(
    file + ManifestSuffix,
    JSON.stringify({ version: 1, programId, identity, acquisition }),
  );
}

export async function admitAcquiredSubtitleCache(
  file: string,
  programId: string,
  identity: string,
  acquisition: SubtitleAcquisition,
  source: { type: string; path: string },
  revision?: string | null,
) {
  if (identity !== (await subtitleSourceIdentity(source, revision))) {
    await fs.rm(file, { force: true });
    throw new Error(
      'Source changed during subtitle acquisition; cache was not admitted',
    );
  }
  await recordSubtitleCache(file, programId, identity, acquisition);
}

/** Acquired tracks live outside scanner-owned rows and survive source rescans. */
export async function acquiredSubtitles(
  folder: string,
  programId: string,
  identity: string,
) {
  const directory = path.join(folder, acquiredSubtitleDirectory(programId));
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const subtitles: (SubtitleAcquisition & {
    path: string;
    codec: 'srt' | 'ass';
  })[] = [];
  for (const entry of entries) {
    const codec = entry.endsWith('.srt' + ManifestSuffix)
      ? 'srt'
      : entry.endsWith('.ass' + ManifestSuffix)
        ? 'ass'
        : undefined;
    if (!codec) continue;
    const file = path.join(directory, entry.slice(0, -ManifestSuffix.length));
    const manifest = await readManifest(file + ManifestSuffix);
    if (
      manifest?.programId !== programId ||
      !manifest.acquisition ||
      !(await hasSubtitleCache(file, identity))
    )
      continue;
    subtitles.push({ ...manifest.acquisition, path: file, codec });
  }
  return subtitles;
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

/** Own manifested cache files; scanner-owned sidecars have a separate lifecycle. */
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
  await sweepPgsTemporaryDirectories(folder);
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
    if (!manifest) continue;
    const state = states.get(manifest.programId);
    if (manifest.acquisition) {
      // Trash is recoverable; keep acquired copies until the program is deleted.
      if (state !== undefined) continue;
    } else {
      if (references.has(manifest.programId)) continue;
      // Preserve missing embedded extractions until trash repair resolves them.
      if (state !== undefined && state !== 'ok') continue;
    }
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
