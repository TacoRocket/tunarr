import type * as SelectiveMatroska from '../services/subtitles/SelectiveMatroskaReader.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSourceId } from '../db/schema/base.ts';
import { Result } from '../types/result.ts';
import { SubtitleExtractionProcess } from './SubtitleExtractionProcess.ts';
import * as Globals from '../globals.ts';
import { StreamSelector } from '../ffmpeg/StreamSelector.ts';
import { SubtitleExtractorTask } from './SubtitleExtractorTask.ts';

vi.mock(
  '../services/subtitles/SelectiveMatroskaReader.ts',
  async (importOriginal) => {
    const actual = await importOriginal<typeof SelectiveMatroska>();
    return {
      ...actual,
      createSubtitleMatroska: vi.fn(async () => {
        throw new actual.UnsupportedMatroskaError(
          'Fixture uses FFmpeg fallback',
        );
      }),
    };
  },
);

vi.mock('@/util/logging/LoggerFactory.js', () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    setBindings: vi.fn(),
  };
  return {
    LoggerFactory: {
      isInitialized: true,
      root: logger,
      child: () => logger,
    },
  };
});

// The task only needs TVGuideService as an injection token here, and importing
// the real one drags the DI container in through the scheduler, which cannot be
// constructed mid-import.
vi.mock('../services/TvGuideService.ts', () => ({
  TVGuideService: class {},
}));

// Used by PathCalculator (shared-storage lookups) and by the task's own
// check for whether an already-recorded subtitle file is still there.
const mockFileExists = vi.fn<(p: string) => Promise<boolean>>();
vi.mock('../util/fsUtil.ts', () => ({
  fileExists: (p: string) => mockFileExists(p),
}));

const sample = {
  elapsedSeconds: 2,
  bytesRead: 1e9,
  secondsPerGB: 2,
  longestProgressPauseSeconds: 1,
};

const MEDIA_SOURCE_ID = 'media-source-1' as MediaSourceId;
const PROGRAM_ID = 'program-1';
const CHANNEL_ID = 'channel-1';
const OTHER_CHANNEL_ID = 'channel-2';
const SOURCE_SUBTITLE_PATH = '/data/media/movie.eng.srt';
const SHARED_SUBTITLE_PATH = '/mnt/media/movie.eng.srt';
const CACHED_SUBTITLE_PATH = '/tmp/test-tunarr/cache/subtitles/ab/cd/abcd.srt';
const SUBTITLE_KEY = '/Videos/jf-item-1/jf-item-1/Subtitles/0/Stream.srt';

type SubtitleRow = {
  uuid: string;
  subtitleType: 'embedded' | 'sidecar';
  codec: string;
  language: string;
  path?: string | null;
  sourcePath?: string | null;
  sourceKey?: string | null;
  streamIndex?: number | null;
  isExtracted?: boolean;
};

function makeSubtitle(row: SubtitleRow) {
  return {
    default: false,
    forced: false,
    isExtracted: false,
    path: null,
    programId: PROGRAM_ID,
    sdh: false,
    sourceKey: null,
    sourcePath: null,
    streamIndex: null,
    ...row,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: {
  subtitles: SubtitleRow[];
  sourceType?: 'jellyfin' | 'emby' | 'plex';
  replacePaths?: { localPath: string; serverPath: string }[];
  subtitlesEnabled?: boolean;
  enableSubtitleExtraction?: boolean;
  downloadedPath?: string;
  databaseDirectory?: string;
  sourcePath?: string;
  streamMode?: string;
  secondChannelEnabled?: boolean;
}) {
  const sourceType = opts.sourceType ?? 'jellyfin';

  const mediaSource = {
    uuid: MEDIA_SOURCE_ID,
    name: 'Test Source',
    type: sourceType,
    uri: 'http://localhost:8096',
    accessToken: 'token',
    libraries: [],
    paths: [],
    replacePaths: opts.replacePaths ?? [],
  };

  const dbProgram = {
    uuid: PROGRAM_ID,
    duration: 100000,
    type: 'movie',
    title: 'Test Movie',
    externalKey: 'jf-item-1',
    mediaSourceId: MEDIA_SOURCE_ID,
    sourceType,
    subtitles: opts.subtitles.map(makeSubtitle),
    externalIds: [],
  };

  const setSubtitlePath = vi.fn<(uuid: string, path: string) => Promise<void>>(
    () => Promise.resolve(),
  );
  const getSubtitlesByPath = vi.fn(() => Promise.resolve('subtitle contents'));
  const getSubtitlesByKey = vi.fn(() => Promise.resolve('subtitle contents'));

  // Stands in for the real downloader: runs the fetch callback the task hands
  // it, so the test also covers which client method the task reaches for.
  const downloadSubtitlesIfNecessary = vi.fn(
    async (
      _item: unknown,
      _details: unknown,
      cb: (args: { extension: string }) => Promise<unknown>,
    ) => {
      await cb({ extension: 'srt' });
      return opts.downloadedPath;
    },
  );

  const apiClient = {
    getSubtitlesByPath,
    getSubtitles: getSubtitlesByKey,
  };

  const getChannelGuides = vi.fn((_range: unknown, channelIds: string[]) =>
    Promise.resolve(
      channelIds.includes(CHANNEL_ID)
        ? [
            {
              id: CHANNEL_ID,
              programs: [
                {
                  type: 'content',
                  id: PROGRAM_ID,
                  start: Date.now(),
                  stop: Date.now() + 100000,
                  program: {
                    title: 'Test Movie',
                    externalId: 'jf-item-1',
                    mediaSourceId: MEDIA_SOURCE_ID,
                    sourceType,
                  },
                },
              ],
            },
          ]
        : [],
    ),
  );

  const getStream = vi.fn(() =>
    Promise.resolve(
      Result.success({
        streamSource: {
          type: opts.sourcePath ? 'file' : 'http',
          path: opts.sourcePath ?? '/media/episode.mkv',
        },
        streamDetails: {
          audioDetails: [{ index: 1, language: 'eng' }],
          subtitleDetails: Array.from({ length: 8 }, (_, index) => ({
            type: 'embedded',
            index: index + 2,
            codec: 'subrip',
            language: index === 0 ? 'eng' : index === 1 ? 'por' : 'ces',
            default: false,
            forced: false,
            sdh: false,
          })),
        },
      }),
    ),
  );

  const selectAudioAndSubtitleStreams = vi.fn<
    StreamSelector['selectAudioAndSubtitleStreams']
  >(async ({ audioStreams, subtitleStreams }) => ({
    audioStream: audioStreams[0],
    subtitleStream: null,
    unextractedSubtitle: subtitleStreams[0],
  }));
  const getProgramById = vi.fn(async (_id: string) => dbProgram);
  const prepareProgramSubtitles = vi.fn(async () => ({
    status: 'needs-selection',
    provider: 'plex',
    candidates: [],
  }));
  const task = new SubtitleExtractorTask(
    {
      get: () => Promise.resolve({}),
      getChannelGuides,
    } as never,
    {
      getAllChannels: () =>
        Promise.resolve([
          {
            uuid: CHANNEL_ID,
            streamMode: opts.streamMode ?? 'hls',
            subtitlesEnabled: opts.subtitlesEnabled ?? true,
          },
          {
            uuid: OTHER_CHANNEL_ID,
            subtitlesEnabled: opts.secondChannelEnabled ?? false,
            streamMode: 'hls',
          },
        ]),
    } as never,
    {
      getStream,
    } as never,
    { getAll: () => Promise.resolve([mediaSource]) } as never,
    {
      ffmpegSettings: () => ({
        enableSubtitleExtraction: opts.enableSubtitleExtraction ?? false,
      }),
    } as never,
    {
      databaseDirectory: opts.databaseDirectory ?? '/tmp/test-tunarr',
    } as never,
    {
      getProgramById,
      setSubtitlePath,
    } as never,
    { downloadSubtitlesIfNecessary } as never,
    {
      getJellyfinApiClientForMediaSource: () => Promise.resolve(apiClient),
      getEmbyApiClientForMediaSource: () => Promise.resolve(apiClient),
      getPlexApiClientForMediaSource: () => Promise.resolve(apiClient),
    } as never,
    { selectAudioAndSubtitleStreams } as never,
    { all: () => [] } as never,
    {
      loadAllLineups: async () => ({
        [CHANNEL_ID]: {
          lineup: { items: [{ type: 'content', id: PROGRAM_ID }] },
        },
      }),
    } as never,
    { prepare: prepareProgramSubtitles } as never,
  );

  return {
    prepareProgramSubtitles,
    task,
    getProgramById,
    selectAudioAndSubtitleStreams,
    getStream,
    getChannelGuides,
    dbProgram,
    setSubtitlePath,
    downloadSubtitlesIfNecessary,
    getSubtitlesByPath,
    getSubtitlesByKey,
  };
}

async function run(harness: Harness) {
  const result = await harness.task.run({});
  expect(result.isSuccess()).toBe(true);
}

describe('SubtitleExtractorTask single-program request', () => {
  it('prepares the requested program and returns its selection result instead of succeeding without work', async () => {
    const h = makeHarness({ subtitles: [] });
    const request = h.task.schema.parse({
      filter: { type: 'program', programId: PROGRAM_ID },
    });
    const result = await h.task.run(request);
    expect(result.isSuccess()).toBe(true);
    expect(h.prepareProgramSubtitles).toHaveBeenCalledExactlyOnceWith({
      type: 'program',
      programId: PROGRAM_ID,
      sdh: false,
    });
    expect(result.get()).toEqual({
      status: 'needs-selection',
      provider: 'plex',
      candidates: [],
    });
    expect(h.getChannelGuides).not.toHaveBeenCalled();
  });
});

describe('SubtitleExtractorTask external subtitle top-up', () => {
  beforeEach(() => {
    mockFileExists.mockReset();
    mockFileExists.mockResolvedValue(false);
  });

  it('requests six hours and prepares the earliest airing first across channels', async () => {
    const h = makeHarness({ subtitles: [] });
    const guides = await h.getChannelGuides(undefined, [CHANNEL_ID]);
    const first = guides[0]?.programs[0];
    if (!first) throw new Error('Missing fixture guide');
    const now = Date.now();
    h.getChannelGuides.mockResolvedValue([
      {
        id: CHANNEL_ID,
        programs: [
          { ...first, id: 'late', start: now + 5 * 3600000 },
          { ...first, id: 'early', start: now + 2 * 3600000 },
          { ...first, id: 'late', start: now + 3600000 },
        ],
      },
    ]);
    await run(h);
    const range = h.getChannelGuides.mock.calls.at(-1)?.[0] as {
      from: { valueOf(): number };
      to: { valueOf(): number };
    };
    expect(range.to.valueOf() - range.from.valueOf()).toBe(6 * 3600000);
    expect(h.getProgramById.mock.calls.map((args) => args[0])).toEqual([
      'late',
      'early',
    ]);
  });

  it('leaves a sidecar alone when its recorded file is still on disk', async () => {
    mockFileExists.mockImplementation((p) =>
      Promise.resolve(p === CACHED_SUBTITLE_PATH),
    );

    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          path: CACHED_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('prefers storage shared with the media source over downloading', async () => {
    mockFileExists.mockImplementation((p) =>
      Promise.resolve(p === SHARED_SUBTITLE_PATH),
    );

    const harness = makeHarness({
      replacePaths: [{ localPath: '/mnt/media', serverPath: '/data/media' }],
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourcePath: SOURCE_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).toHaveBeenCalledWith(
      'sub-1',
      SHARED_SUBTITLE_PATH,
    );
  });

  it('downloads a sidecar the scan never managed to fetch', async () => {
    const harness = makeHarness({
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourcePath: SOURCE_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
    expect(harness.setSubtitlePath).toHaveBeenCalledWith(
      'sub-1',
      CACHED_SUBTITLE_PATH,
    );
    // The in-memory row is kept in step with what was persisted.
    expect(harness.dbProgram.subtitles[0]?.path).toBe(CACHED_SUBTITLE_PATH);
  });

  it('re-downloads a sidecar whose cached copy has been deleted', async () => {
    const harness = makeHarness({
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          // Recorded during a previous scan, but the file is gone.
          path: CACHED_SUBTITLE_PATH,
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
  });

  it('addresses Jellyfin and Emby subtitles by their delivery route', async () => {
    for (const sourceType of ['jellyfin', 'emby'] as const) {
      const harness = makeHarness({
        sourceType,
        downloadedPath: CACHED_SUBTITLE_PATH,
        subtitles: [
          {
            uuid: 'sub-1',
            subtitleType: 'sidecar',
            codec: 'subrip',
            language: 'eng',
            sourceKey: SUBTITLE_KEY,
          },
        ],
      });

      await run(harness);

      expect(harness.getSubtitlesByPath).toHaveBeenCalledWith(SUBTITLE_KEY);
    }
  });

  it('addresses Plex subtitles by their stream key', async () => {
    const harness = makeHarness({
      sourceType: 'plex',
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: '/library/streams/12345',
        },
      ],
    });

    await run(harness);

    expect(harness.getSubtitlesByKey).toHaveBeenCalledWith(
      '/library/streams/12345',
    );
  });

  it('does not record a path when the download fails', async () => {
    const harness = makeHarness({
      // The downloader returns nothing when it could not write a file.
      downloadedPath: undefined,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('ignores embedded subtitles, which are extracted rather than fetched', async () => {
    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'embedded',
          codec: 'subrip',
          language: 'eng',
          streamIndex: 2,
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
  });

  it('skips a sidecar with no way to reach it', async () => {
    const harness = makeHarness({
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
        },
      ],
    });

    await run(harness);

    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
    expect(harness.setSubtitlePath).not.toHaveBeenCalled();
  });

  it('skips channels that have subtitles turned off', async () => {
    const harness = makeHarness({
      subtitlesEnabled: false,
      downloadedPath: CACHED_SUBTITLE_PATH,
      subtitles: [
        {
          uuid: 'sub-1',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
    });

    await run(harness);

    expect(harness.getChannelGuides).not.toHaveBeenCalled();
    expect(harness.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
  });

  it('loads guides only for channels with subtitles turned on', async () => {
    const harness = makeHarness({ subtitles: [] });

    await run(harness);

    expect(harness.getChannelGuides).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      [CHANNEL_ID],
    );
  });

  it('prepares the selected track once when separate task instances overlap on a file', async () => {
    const databaseDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subtitle-overlap-'),
    );
    const cacheFolder = path.join(databaseDirectory, 'cache', 'subtitles');
    await fs.mkdir(cacheFolder, { recursive: true });
    mockFileExists.mockImplementation(async (file) => {
      try {
        await fs.access(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    const releaseExtraction = Promise.withResolvers<void>();
    const temporaryFiles: string[] = [];
    const extract = vi
      .spyOn(SubtitleExtractionProcess.prototype, 'run')
      .mockImplementation(async (_executable, args) => {
        await releaseExtraction.promise;
        for (let index = 0; index < args.length; index++) {
          if (
            args[index] !== '-map' ||
            ['0:v:0', '0:a:0'].includes(args[index + 1] ?? '')
          )
            continue;
          const output = args[index + 4];
          if (output === undefined) throw new Error('Missing subtitle output');
          temporaryFiles.push(output);
          await fs.writeFile(output, `subtitle ${args[index + 1]}`);
        }
        return sample;
      });
    const options = {
      subtitles: [],
      enableSubtitleExtraction: true,
      databaseDirectory,
    };
    const first = makeHarness(options);
    const second = makeHarness(options);
    const requests = [run(first), run(second)];
    try {
      await vi.waitFor(() => expect(extract).toHaveBeenCalled());
      releaseExtraction.resolve();
      await Promise.all(requests);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(
        extract.mock.calls.map(
          ([, args]) => args.filter((arg) => arg === '-c:s').length,
        ),
      ).toEqual([1]);
      const files = (await fs.readdir(cacheFolder, { recursive: true })).filter(
        (file) => file.endsWith('.srt'),
      );
      expect(files).toHaveLength(1);
      // A later request still checks the cache and restores a missing track.
      const missingFile = files[0];
      if (missingFile === undefined) throw new Error('No extracted subtitles');
      await fs.unlink(path.join(cacheFolder, missingFile));
      await run(makeHarness(options));
      expect(extract).toHaveBeenCalledTimes(2);
      expect(
        extract.mock.calls.map(
          ([, args]) => args.filter((arg) => arg === '-c:s').length,
        ),
      ).toEqual([1, 1]);
    } finally {
      releaseExtraction.resolve();
      await Promise.all(requests);
      extract.mockRestore();
      await Promise.all(
        temporaryFiles.map((file) => fs.rm(file, { force: true })),
      );
      await fs.rm(databaseDirectory, { recursive: true });
    }
  });
});

// #81: a file whose extraction fails used to be reread back to back by every
// queued trigger. These cover joining the attempt in flight and holding off a
// retry until the file changes or the wait is over.
describe('SubtitleExtractorTask after a failed extraction', () => {
  let databaseDirectory: string;

  beforeEach(async () => {
    databaseDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'subtitle-failure-'),
    );
    await fs.mkdir(path.join(databaseDirectory, 'cache', 'subtitles'), {
      recursive: true,
    });
    SubtitleExtractorTask['successfulExtractions'].clear();
    mockFileExists.mockReset();
    mockFileExists.mockImplementation(async (file) => {
      try {
        await fs.access(file);
        return true;
      } catch {
        return false;
      }
    });
    return async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await fs.rm(databaseDirectory, { recursive: true });
    };
  });

  const harness = (sourcePath?: string) =>
    makeHarness({
      subtitles: [],
      enableSubtitleExtraction: true,
      databaseDirectory,
      sourcePath,
    });

  const failingExtraction = (until?: Promise<void>) =>
    vi
      .spyOn(SubtitleExtractionProcess.prototype, 'run')
      .mockImplementation(async () => {
        await until;
        throw new Error('Command failed: stalled for 60 seconds');
      });

  it('overlapping requests share one failing extraction instead of each running it', async () => {
    const release = Promise.withResolvers<void>();
    const extract = failingExtraction(release.promise);

    const requests = [run(harness()), run(harness()), run(harness())];
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    release.resolve();
    await Promise.all(requests);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(SubtitleExtractorTask['successfulExtractions'].size).toBe(0);
  });

  it('serializes different files across overlapping task runs', async () => {
    const gate = Promise.withResolvers<void>();
    const extract = failingExtraction(gate.promise);
    const firstPath = path.join(databaseDirectory, 'first.mkv');
    const secondPath = path.join(databaseDirectory, 'second.mkv');
    await fs.writeFile(firstPath, 'first');
    await fs.writeFile(secondPath, 'second');
    const first = run(harness(firstPath));
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    const second = run(harness(secondPath));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extract).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('does not read a failed file again until the wait is over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T08:00:00Z'));
    const extract = failingExtraction();

    await run(harness());
    // The next hourly run and a guide rebuild leave it alone.
    vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));
    await run(harness());
    await run(harness());
    expect(extract).toHaveBeenCalledTimes(1);

    // Six hours after the failure it gets another chance.
    vi.setSystemTime(new Date('2026-10-30T14:00:00Z'));
    await run(harness());
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('retries right away when the file changes', async () => {
    const extract = failingExtraction();

    const original = path.join(databaseDirectory, 'movie.Remux-2160p.mkv');
    const upgrade = path.join(databaseDirectory, 'movie.Bluray-1080p.mkv');
    await fs.writeFile(original, 'original');
    await fs.writeFile(upgrade, 'upgrade');
    await run(harness(original));
    // An upgrade replaced the file.
    await run(harness(upgrade));

    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('retries when the same file is replaced in place', async () => {
    const source = path.join(databaseDirectory, 'movie.mkv');
    await fs.writeFile(source, 'original');
    const extract = failingExtraction();

    await run(harness(source));
    await run(harness(source));
    expect(extract).toHaveBeenCalledTimes(1);

    await fs.writeFile(source, 'a replacement with a different size');
    await run(harness(source));
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('extracts normally again once a retry succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T08:00:00Z'));
    const extract = failingExtraction();
    await run(harness());

    vi.setSystemTime(new Date('2026-10-30T15:00:00Z'));
    extract.mockImplementation(async (_executable, args) => {
      for (let index = 0; index < args.length; index++) {
        if (
          args[index] === '-map' &&
          !['0:v:0', '0:a:0'].includes(args[index + 1] ?? '')
        ) {
          await fs.writeFile(args[index + 4]!, 'subtitle');
        }
      }
      return sample;
    });
    await run(harness());
    expect(extract).toHaveBeenCalledTimes(2);

    // Cached now: a later run reads nothing.
    await run(harness());
    expect(extract).toHaveBeenCalledTimes(2);
  });

  const successfulExtraction = () =>
    vi
      .spyOn(SubtitleExtractionProcess.prototype, 'run')
      .mockImplementation(async (_executable, args) => {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-c:s') {
            const output = args[i + 2];
            if (!output) throw new Error('Missing subtitle output');
            await fs.writeFile(output, 'subtitle');
          }
        }
        return sample;
      });

  it('extracts intended English text from an empty cache and playback then selects the cache', async () => {
    const h = harness();
    vi.spyOn(Globals, 'globalOptions').mockReturnValue({
      databaseDirectory,
    } as never);
    const selector = new StreamSelector(
      {
        resolve: async () => ({
          rules: [
            {
              condition: 'true',
              audioAction: { type: 'default' },
              subtitleAction: {
                type: 'by_language',
                languages: ['eng'],
                filterType: 'any',
                allowExternal: true,
                allowImageBased: true,
              },
            },
          ],
        }),
      } as never,
      { evaluate: () => true } as never,
    );
    h.selectAudioAndSubtitleStreams.mockImplementation((request) =>
      selector.selectAudioAndSubtitleStreams(request),
    );
    const extract = successfulExtraction();
    await run(h);
    const request = h.selectAudioAndSubtitleStreams.mock.calls[0]?.[0];
    if (!request) throw new Error('Missing selection request');
    const selected = await selector.selectAudioAndSubtitleStreams(request);
    expect(selected.unextractedSubtitle).toBeUndefined();
    expect(selected.subtitleStream?.type).toBe('external');
    expect(selected.subtitleStream?.path).toContain(databaseDirectory);
    expect(
      extract.mock.calls[0]?.[1].filter((arg) => arg === '-c:s'),
    ).toHaveLength(1);
    await run(h);
    expect(extract).toHaveBeenCalledTimes(1);
    expect([
      ...SubtitleExtractorTask['successfulExtractions'].values(),
    ]).toEqual([[sample]]);
  });

  it.each(['image', 'external', 'disabled'] as const)(
    'does not read a file when playback selects %s subtitles',
    async (kind) => {
      const h = harness();
      h.selectAudioAndSubtitleStreams.mockImplementation(
        async ({ audioStreams }) => ({
          audioStream: audioStreams[0],
          subtitleStream:
            kind === 'disabled'
              ? null
              : {
                  type: kind === 'external' ? 'external' : 'embedded',
                  codec: kind === 'image' ? 'hdmv_pgs_subtitle' : 'subrip',
                  index: 3,
                  default: false,
                  forced: false,
                  sdh: false,
                },
        }),
      );
      const extract = successfulExtraction();
      await run(h);
      expect(extract).not.toHaveBeenCalled();
      expect(SubtitleExtractorTask['successfulExtractions'].size).toBe(0);
    },
  );

  it('shares sidecar preparation across overlapping task instances', async () => {
    const opts = {
      subtitles: [
        {
          uuid: 'sidecar',
          subtitleType: 'sidecar' as const,
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
      databaseDirectory,
    };
    const first = makeHarness(opts);
    const second = makeHarness(opts);
    const gate = Promise.withResolvers<void>();
    first.downloadSubtitlesIfNecessary.mockImplementation(async () => {
      await gate.promise;
      return undefined;
    });
    const runs = [run(first), run(second)];
    await vi.waitFor(() =>
      expect(first.downloadSubtitlesIfNecessary).toHaveBeenCalled(),
    );
    gate.resolve();
    await Promise.all(runs);
    expect(first.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
    expect(second.downloadSubtitlesIfNecessary).not.toHaveBeenCalled();
  });

  it('keeps sidecar downloads for Direct V2 but skips embedded extraction', async () => {
    const h = makeHarness({
      subtitles: [
        {
          uuid: 'sidecar',
          subtitleType: 'sidecar',
          codec: 'subrip',
          language: 'eng',
          sourceKey: SUBTITLE_KEY,
        },
      ],
      streamMode: 'hls_direct_v2',
      enableSubtitleExtraction: true,
      databaseDirectory,
    });
    const extract = successfulExtraction();
    await run(h);
    expect(h.downloadSubtitlesIfNecessary).toHaveBeenCalledTimes(1);
    expect(h.getStream).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it('unions two channels different tracks into one file read', async () => {
    const h = makeHarness({
      subtitles: [],
      enableSubtitleExtraction: true,
      databaseDirectory,
      secondChannelEnabled: true,
    });
    const guides = await h.getChannelGuides(undefined, [CHANNEL_ID]);
    const guide = guides[0];
    if (!guide) throw new Error('Missing guide');
    h.getChannelGuides.mockResolvedValue([
      ...guides,
      { ...guide, id: OTHER_CHANNEL_ID },
    ]);
    h.selectAudioAndSubtitleStreams.mockImplementation(
      async ({ audioStreams, subtitleStreams, channel }) => ({
        audioStream: audioStreams[0],
        subtitleStream: null,
        unextractedSubtitle:
          subtitleStreams[channel.uuid === CHANNEL_ID ? 0 : 1],
      }),
    );
    const extract = successfulExtraction();
    await run(h);
    expect(h.getStream).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(
      extract.mock.calls[0]?.[1].filter((arg) => arg === '-c:s'),
    ).toHaveLength(2);
    await run(h);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

// The cold-library review showed hours of work can be admitted by one six-hour
// sweep. Exercise admission with elapsed work simulated, without reading media.
describe('SubtitleExtractorTask cold-cache work budget', () => {
  it('finishes admitted work, shares the allowance across triggers, and still admits urgent files', async () => {
    const databaseDirectory = '/tmp/subtitle-budget-check';
    SubtitleExtractorTask['lookaheadBudgets'].clear();
    let elapsed = 0;
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => elapsed);
    const first = makeHarness({ subtitles: [], databaseDirectory }).task;
    const second = makeHarness({ subtitles: [], databaseDirectory }).task;
    const extracted: string[] = [];
    const extract = async (key: string) => {
      extracted.push(key);
      elapsed += 6 * 60_000;
    };
    const originalFirstExtract = first['extractFile'];
    const originalSecondExtract = second['extractFile'];
    first['extractFile'] = extract;
    second['extractFile'] = extract;
    const file: Parameters<SubtitleExtractorTask['prepareFile']>[1] = {
      earliestAiring: Date.now() + 4 * 3600000,
      source: { type: 'file', path: '/unused/movie.mkv' },
      revision: null,
      identity: 'source',
      progressStream: '0:v:0',
      mediaSourceIds: new Set(),
      outputs: new Map(),
    };
    try {
      expect(await first['prepareFile']('one', file)).toBe(true);
      // A second six-minute file is allowed to finish past the ten-minute budget.
      expect(await first['prepareFile']('two', file)).toBe(true);
      expect(await second['prepareFile']('deferred', file)).toBe(false);
      expect(extracted).toEqual(['one', 'two']);
      expect(
        await second['prepareFile']('urgent', {
          ...file,
          earliestAiring: Date.now() + 30 * 60000,
        }),
      ).toBe(true);
      expect(await first['prepareFile']('still-deferred', file)).toBe(false);
      elapsed = 60 * 60000;
      expect(await second['prepareFile']('next-hour', file)).toBe(true);
      expect(extracted).toEqual(['one', 'two', 'urgent', 'next-hour']);
    } finally {
      first['extractFile'] = originalFirstExtract;
      second['extractFile'] = originalSecondExtract;
      clock.mockRestore();
      SubtitleExtractorTask['lookaheadBudgets'].clear();
    }
  });
});
