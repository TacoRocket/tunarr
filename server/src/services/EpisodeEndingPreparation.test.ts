import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import { setGlobalOptionsUnchecked } from '../globals.ts';
import { FileStreamSource, type ProgramStreamResult } from '../stream/types.ts';
import { Result } from '../types/result.ts';
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
  const server = { type: 'plex' } as MediaSourceWithRelations;
  const media: ProgramStreamResult = {
    streamSource: new FileStreamSource(file),
    streamDetails: {
      duration: dayjs.duration(program.duration),
      videoDetails: [
        { width: 720, height: 480, displayAspectRatio: '4:3' } as never,
      ],
    },
  };
  const client = {
    getItemMetadataRaw: vi.fn(),
    requestEpisodeCreditScan: vi.fn(),
  };
  const clients = {
    getPlexApiClientForMediaSource: async () => client,
  } as unknown as MediaSourceApiFactory;
  client.getItemMetadataRaw.mockResolvedValue(
    Result.success({ type: 'episode', ratingKey: '7', Marker: [] }),
  );
  const run = () =>
    new EpisodeEndingPreparation({} as ISettingsDB, clients).prepare(
      program,
      server,
      media,
      async () => undefined,
    );
  return { program, media, client, run };
}

test('remembers a completed scan with no marker across preparations and restarts', async () => {
  const { program, media, client, run } = await fixture();
  await Promise.all([run(), run()]);
  await run();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  await run();
  client.getItemMetadataRaw.mockClear();
  await run();
  expect(client.getItemMetadataRaw).not.toHaveBeenCalled();
  expect(client.requestEpisodeCreditScan).toHaveBeenCalledTimes(1);
  expect(await readPreparedEnding(program, media)).toBeUndefined();
});

test('reads back a late final marker after a lost scan reply without submitting again', async () => {
  const { program, media, client, run } = await fixture();
  client.requestEpisodeCreditScan.mockRejectedValueOnce(
    new Error('lost response'),
  );
  await expect(run()).rejects.toThrow('lost response');
  client.getItemMetadataRaw.mockResolvedValue(
    Result.success({
      type: 'episode',
      ratingKey: '7',
      Marker: [
        {
          type: 'credits',
          final: true,
          startTimeOffset: 90_000,
          endTimeOffset: 100_000,
        },
      ],
    }),
  );
  await run();
  expect(await readPreparedEnding(program, media)).toMatchObject({
    startTime: 90_000,
    endTime: 100_000,
    isFinal: true,
  });
  await fs.writeFile(media.streamSource.path, 'replacement file');
  expect(await readPreparedEnding(program, media)).toBeUndefined();
  expect(client.requestEpisodeCreditScan).toHaveBeenCalledTimes(1);
});
