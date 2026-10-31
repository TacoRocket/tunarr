import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LineupRepository } from '../../db/channel/LineupRepository.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { acquiredSubtitleDirectory } from '../../util/subtitles.ts';
import {
  acquiredSubtitles,
  admitAcquiredSubtitleCache,
  hasSubtitleCache,
  recordSubtitleCache,
  retireReplacedSubtitleCache,
  subtitleSourceIdentity,
  sweepSubtitleCache,
} from './SubtitleCache.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-cache-'));
  directories.push(folder);
  const source = { type: 'file', path: path.join(folder, 'movie.mkv') };
  await fs.writeFile(source.path, 'original media');
  const file = path.join(folder, 'cached.srt');
  const identity = await subtitleSourceIdentity(source);
  await fs.writeFile(file, 'original subtitles');
  await recordSubtitleCache(file, 'movie', identity);
  return { folder, source, file, identity };
}

describe('subtitle cache file replacement', () => {
  it('keeps acquired subtitles while unscheduled or in Trash, then removes them after deletion', async () => {
    const { folder, identity } = await fixture();
    const file = path.join(
      folder,
      acquiredSubtitleDirectory('movie'),
      'english.srt',
    );
    const acquisition = {
      provider: 'plex' as const,
      language: 'eng',
      forced: false,
      sdh: false,
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'acquired subtitles');
    await recordSubtitleCache(file, 'movie', identity, acquisition);
    let states = [{ id: 'movie', state: 'ok' }];
    let calls = 0;
    const db = {
      all: () => (++calls % 2 === 1 ? [] : states),
    } as unknown as DrizzleDBAccess;
    const lineups = {
      loadAllLineups: async () => ({}),
    } as unknown as LineupRepository;
    for (const state of ['ok', 'missing', 'ok']) {
      states = [{ id: 'movie', state }];
      await sweepSubtitleCache(folder, db, lineups);
      expect(await acquiredSubtitles(folder, 'movie', identity)).toEqual([
        { ...acquisition, path: file },
      ]);
      expect(await acquiredSubtitles(folder, 'movie', 'replacement')).toEqual(
        [],
      );
    }
    states = [];
    expect(await sweepSubtitleCache(folder, db, lineups)).toBe(1);
    expect(await acquiredSubtitles(folder, 'movie', identity)).toEqual([]);
  });

  it('removes an unmanifested acquired download when the source changes before admission', async () => {
    const { folder, source, identity } = await fixture();
    const file = path.join(folder, 'unadmitted.srt');
    await fs.writeFile(file, 'acquired subtitles');
    await fs.writeFile(source.path, 'replacement media');
    await expect(
      admitAcquiredSubtitleCache(
        file,
        'movie',
        identity,
        {
          provider: 'plex',
          language: 'eng',
          forced: false,
          sdh: false,
        },
        source,
      ),
    ).rejects.toThrow('Source changed during subtitle acquisition');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(file + '.source.json')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reuses an unchanged file and rejects an upgrade at the same path and program ID', async () => {
    const { folder, source, file, identity } = await fixture();
    const before = await fs.stat(file);
    expect(
      await hasSubtitleCache(file, await subtitleSourceIdentity(source)),
    ).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    // Same size and restored mtime: replacement must still invalidate the cache.
    const original = await fs.stat(source.path);
    const replacement = path.join(folder, 'replacement.mkv');
    await fs.writeFile(replacement, 'upgraded media');
    await fs.utimes(replacement, original.atime, original.mtime);
    await fs.rename(replacement, source.path);
    const upgradedIdentity = await subtitleSourceIdentity(source);
    expect(upgradedIdentity).not.toBe(identity);
    expect(await hasSubtitleCache(file, upgradedIdentity)).toBe(false);
    const upgraded = path.join(folder, 'upgraded.srt');
    await fs.writeFile(upgraded, 'upgraded subtitles');
    await recordSubtitleCache(upgraded, 'movie', upgradedIdentity);
    await retireReplacedSubtitleCache(folder, 'movie', upgradedIdentity);
    expect(await hasSubtitleCache(upgraded, upgradedIdentity)).toBe(true);
    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });

  it('retains lineup references outside lookahead and pending trash repair, then removes unreferenced cache', async () => {
    const { folder, file, identity } = await fixture();
    let items: { type: string; id: string }[] = [
      { type: 'content', id: 'movie' },
    ];
    let states = [{ id: 'movie', state: 'ok' }];
    const db = {
      all: (query: unknown) => {
        void query;
        return ++calls % 2 === 1 ? [] : states;
      },
    } as unknown as DrizzleDBAccess;
    let calls = 0;
    const lineups = {
      loadAllLineups: async () => ({ channel: { lineup: { items } } }),
    } as unknown as LineupRepository;
    expect(await sweepSubtitleCache(folder, db, lineups)).toBe(0);
    expect(await hasSubtitleCache(file, identity)).toBe(true);
    items = [];
    states = [{ id: 'movie', state: 'missing' }];
    expect(await sweepSubtitleCache(folder, db, lineups)).toBe(0);
    states = [];
    expect(await sweepSubtitleCache(folder, db, lineups)).toBe(1);
    expect(await hasSubtitleCache(file, identity)).toBe(false);
  });
});
