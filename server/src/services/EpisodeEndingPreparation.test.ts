import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import { setGlobalOptionsUnchecked } from '../globals.ts';
import { FileStreamSource, type ProgramStreamResult } from '../stream/types.ts';
import {
  EpisodeEndingPreparation,
  readPreparedEnding,
} from './EpisodeEndingPreparation.ts';

dayjs.extend(duration);
let folder: string;
beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ending-prep-'));
  setGlobalOptionsUnchecked({
    database: folder,
    log_level: 'silent',
    verbose: 0,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(folder, { recursive: true, force: true });
});

async function fixture() {
  const file = path.join(folder, 'episode.mkv');
  await fs.writeFile(file, 'episode');
  const program = {
    type: 'episode',
    mediaSourceId: 'server',
    externalKey: '7',
    duration: 100_000,
    canonicalId: 'revision',
  } as StreamLineupProgram;
  const media: ProgramStreamResult = {
    streamSource: new FileStreamSource(file),
    streamDetails: {
      duration: dayjs.duration(program.duration),
      videoDetails: [
        { width: 720, height: 480, displayAspectRatio: '4:3' } as never,
      ],
    },
  };
  const getMedia = vi.fn(async () => media);
  const run = () =>
    new EpisodeEndingPreparation({} as ISettingsDB).prepare(
      program,
      getMedia,
      async () => undefined,
    );
  return { program, media, getMedia, run };
}

test('skips stream lookups on repeat guide passes until the episode changes', async () => {
  const { program, media, getMedia, run } = await fixture();
  await run();
  await run();
  expect(getMedia).toHaveBeenCalledTimes(1);
  expect(await readPreparedEnding(program, media)).toBeUndefined();
  program.updatedAt = Date.now();
  await run();
  expect(getMedia).toHaveBeenCalledTimes(2);
});

test('uses existing final credits and rechecks a replaced local file', async () => {
  const { program, media, getMedia, run } = await fixture();
  media.streamDetails.chapters = [
    {
      chapterType: 'outro',
      isFinal: true,
      startTime: 90_000,
      endTime: 100_000,
      index: 0,
    },
  ];
  await run();
  await run();
  expect(getMedia).toHaveBeenCalledTimes(1);
  expect(await readPreparedEnding(program, media)).toMatchObject({
    startTime: 90_000,
    endTime: 100_000,
    isFinal: true,
  });
  await fs.writeFile(media.streamSource.path, 'replacement file');
  expect(await readPreparedEnding(program, media)).toBeUndefined();
  await run();
  expect(getMedia).toHaveBeenCalledTimes(2);
});
