import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import { Result } from '@/types/result.js';
import dayjs from 'dayjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProgramStream } from '../ProgramStream.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { HlsSession, nextProgramPtsOffset } from './HlsSession.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('@/stream/ConnectionTracker.ts', () => {
  return {
    ConnectionTracker: class {
      on = vi.fn();
      cancelCleanup = vi.fn();
      recordHeartbeat = vi.fn();
      removeStaleConnections = vi.fn(() => []);
    },
  };
});

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeSession(
  transcodeDirectory: string,
  streamMode: 'hls' | 'hls_direct_v2' = 'hls',
): HlsSession {
  const channel = {
    uuid: channelUuid,
    transcodeConfig: {},
  } as ChannelOrmWithTranscodeConfig;

  const options = {
    streamMode,
    initialSegmentCount: 2,
    transcodeDirectory,
  };

  return new HlsSession(
    channel,
    options,
    {} as StreamProgramCalculator,
    {} as ISettingsDB,
    {} as OnDemandChannelService,
    (() => ({}) as unknown as ProgramStream) as (
      ctx: PlayerContext,
      fmt: OutputFormat,
    ) => ProgramStream,
  );
}
describe('HlsSession', () => {
  test('a failed live source and failed error screen still wait before retrying', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    let resume: (() => void) | undefined;
    vi.mocked(delay).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    try {
      const session = makeSession(dir.name);
      const internals = session as unknown as {
        state: string;
        transcodeLive(
          context: PlayerContext,
          pts: number,
          subtitle: number,
        ): Promise<void>;
        getProgramStream: (...args: unknown[]) => ProgramStream;
      };
      internals.state = 'started';
      const setup = vi.fn().mockResolvedValue(Result.failure('503'));
      const getStream = vi
        .spyOn(internals, 'getProgramStream')
        .mockReturnValue({ setup } as unknown as ProgramStream);
      const context = new PlayerContext(
        {
          type: 'live',
          feed: 'est',
          duration: -1,
          streamDuration: -1,
          programBeginMs: 0,
          infiniteLoop: false,
        },
        session.channel,
        session.channel,
        session.channel.transcodeConfig,
        { audioOnly: false, realtime: true, streamMode: 'hls' },
      );
      let finished = false;
      const work = internals.transcodeLive(context, 0, 0).then(() => {
        finished = true;
      });
      await vi.waitFor(() => expect(delay).toHaveBeenCalled());
      expect(setup).toHaveBeenCalledTimes(2);
      expect(getStream.mock.calls[1]?.[0]).toMatchObject({
        lineupItem: { type: 'error', streamDuration: 10000 },
      });
      expect(getStream.mock.calls.every((call) => call[3] === true)).toBe(true);
      const milliseconds = vi.mocked(delay).mock.calls.at(-1)?.[0];
      expect(milliseconds).toBe(10000);
      expect(finished).toBe(false);
      if (!resume) throw new Error('Retry delay was not reached');
      resume();
      await work;
      expect(finished).toBe(true);
    } finally {
      vi.mocked(delay).mockReset();
      clock.mockRestore();
      dir.removeCallback();
    }
  });

  test('an early video EOF does not credit the missing tail as playable buffer', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-22T22:40:05Z'));
      const session = makeSession(dir.name);
      const internals = session as unknown as {
        run(): Promise<void>;
        startInternal(): Promise<void>;
        getTranscodeBuffer(): Promise<number>;
        transcodedUntil: ReturnType<typeof dayjs>;
      };
      vi.spyOn(internals, 'run').mockResolvedValue();
      await internals.startInternal();
      const scheduledEnd = dayjs().add(124528, 'milliseconds');
      internals.transcodedUntil = scheduledEnd;
      await fs.writeFile(
        path.join(session.workingDirectory, 'stream.m3u8'),
        '#EXTM3U\n#EXTINF:62.333589,\ndata000000.ts\n',
      );
      vi.setSystemTime(new Date('2026-10-22T22:40:23Z'));

      // The observed file produced 62s of a scheduled 124s tail. The old
      // 106s estimate caused a wait; only 44s of video is actually available.
      expect(await internals.getTranscodeBuffer()).toBeCloseTo(44.333, 3);
      expect(internals.transcodedUntil).toBe(scheduledEnd);
    } finally {
      vi.useRealTimers();
      dir.removeCallback();
    }
  });

  describe('getMasterPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when playlist.m3u8 does not exist', async () => {
      // Working directory will be created by initDirectories, but we skip that here.
      // The file simply won't exist.
      const session = makeSession(dir.name);
      const result = await session.getMasterPlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });
  });

  describe('trimPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('never lists a segment below the pruning floor', async () => {
      const session = makeSession(dir.name);
      const internals = session as unknown as {
        run(): Promise<void>;
        startInternal(): Promise<void>;
      };

      // startInternal() sets the playlist start that trimPlaylist() needs.
      // The transcode loop is not under test; stub it rather than sleeping
      // until it fails on the empty mocks.
      vi.spyOn(internals, 'run').mockResolvedValue();
      await internals.startInternal();

      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });

      // ffmpeg writes three lines per segment. A two-line fixture parses to
      // zero segments.
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let i = 0; i < 60; i++) {
        const name = `data${String(i).padStart(6, '0')}.ts`;
        lines.push(
          '#EXTINF:4.000000,',
          '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000+0000',
          name,
        );
        await fs.writeFile(path.join(workingDir, name), '');
      }
      await fs.writeFile(
        path.join(workingDir, 'stream.m3u8'),
        lines.join('\n'),
      );

      session.onSegmentRequested('10.0.0.1', 'data000050.ts');
      expect((await session.trimPlaylist()).get()?.sequence).toBe(40);

      // Wait for the prune to finish removing everything below 40. A fixed
      // sleep raced the deletes on busy CI runners.
      let onDisk: string[] = [];
      await vi.waitFor(
        async () => {
          onDisk = (await fs.readdir(workingDir))
            .filter((f) => f.startsWith('data'))
            .sort();
          expect(onDisk[0]).toBe('data000040.ts');
        },
        { timeout: 5000, interval: 10 },
      );

      // The client rewinds into the range pruning just deleted.
      session.onSegmentRequested('10.0.0.1', 'data000020.ts');
      const playlist = (await session.trimPlaylist()).get()?.playlist ?? '';
      const listed = [...playlist.matchAll(/data\d{6}\.ts/g)]
        .map((m) => m[0])
        .sort();
      expect(listed.length).toBeGreaterThan(0);
      expect(listed[0]).toBe('data000040.ts');
      for (const file of listed) {
        expect(onDisk).toContain(file);
      }
    });
  });

  describe('hls_direct_v2 subtitles muxed with the video', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    function segment(n: number) {
      return [
        '#EXTINF:4.000000,',
        '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000+0000',
        `/stream/channels/x/hls_direct_v2/data${String(n).padStart(6, '0')}.ts`,
      ];
    }

    // Shaped like FFmpeg's live append_list playlist: discont_start leaves
    // two markers ahead of the first segment, and a program boundary carries
    // one more.
    function videoPlaylist(segments: number[], boundaryBefore?: number) {
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-DISCONTINUITY',
        ...segments.flatMap((n) => [
          ...(n === boundaryBefore ? ['#EXT-X-DISCONTINUITY'] : []),
          ...segment(n),
        ]),
      ].join('\n');
    }

    async function startSession(
      files: Record<string, string>,
      streamMode: 'hls' | 'hls_direct_v2' = 'hls_direct_v2',
    ) {
      const session = makeSession(dir.name, streamMode);
      const internals = session as unknown as {
        run(): Promise<void>;
        startInternal(): Promise<void>;
      };
      vi.spyOn(internals, 'run').mockResolvedValue();
      await internals.startInternal();
      await fs.mkdir(session.workingDirectory, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(session.workingDirectory, name), content);
      }
      return session;
    }

    test('mirrors the served video playlist across a program boundary', async () => {
      const session = await startSession({
        'stream.m3u8': videoPlaylist([0, 1, 2, 3, 4], 3),
        ...Object.fromEntries(
          [0, 1, 2, 3, 4].map((n) => [`stream${n}.vtt`, 'WEBVTT\n']),
        ),
      });

      const subs = (await session.alignedSubtitlePlaylist())?.split('\n');
      const video = (await session.trimPlaylist()).get()?.playlist;
      expect(subs).toEqual(
        video
          ?.split('\n')
          .map((line) => line.replace(/data(\d+)\.ts$/, 'subs$1.vtt')),
      );
      // The leading markers are restart artifacts, so the boundary is the
      // only discontinuity and it sits between segments 2 and 3.
      expect(subs).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
      expect(subs?.filter((line) => line === '#EXT-X-DISCONTINUITY')).toEqual([
        '#EXT-X-DISCONTINUITY',
      ]);
      const boundary = subs?.indexOf('#EXT-X-DISCONTINUITY') ?? -1;
      expect(subs?.[boundary - 1]).toMatch(/subs000002\.vtt$/);
      expect(subs?.[boundary + 3]).toMatch(/subs000003\.vtt$/);
    });

    test('serves the subtitle the muxer cut with each segment', async () => {
      const session = await startSession({
        'stream.m3u8': videoPlaylist([0, 1, 2]),
        'stream1.vtt': 'WEBVTT\n\n00:41.200 --> 00:44.000\nA3\n',
      });

      expect(await session.subtitleWindow(1)).toContain(
        '00:41.200 --> 00:44.000\nA3',
      );
      // No file: a segment from a program without the muxed subtitle.
      expect(await session.subtitleWindow(2)).toBe('WEBVTT\n');
    });

    test('deletes muxed subtitle files with their segments, not other .vtt files', async () => {
      const segments = [...Array(60).keys()];
      const session = await startSession({
        'stream.m3u8': videoPlaylist(segments),
        ...Object.fromEntries(
          segments.flatMap((n) => [
            [`data${String(n).padStart(6, '0')}.ts`, ''],
            [`stream${n}.vtt`, 'WEBVTT\n'],
          ]),
        ),
        'sub000001.vtt': 'WEBVTT\n',
      });

      session.onSegmentRequested('10.0.0.1', 'data000050.ts');
      expect((await session.trimPlaylist()).get()?.sequence).toBe(40);

      let vtt: string[] = [];
      await vi.waitFor(
        async () => {
          vtt = (await fs.readdir(session.workingDirectory)).filter((f) =>
            f.endsWith('.vtt'),
          );
          expect(vtt).not.toContain('stream39.vtt');
        },
        { timeout: 5000, interval: 10 },
      );
      expect(vtt).toContain('stream40.vtt');
      expect(vtt).toContain('sub000001.vtt');
    });

    test('transcoded HLS still builds windows from cue files and prunes them', async () => {
      const segments = [...Array(60).keys()];
      const session = await startSession(
        {
          'stream.m3u8': videoPlaylist(segments),
          'sub000000.vtt': 'WEBVTT\n\n00:10.000 --> 00:11.000\nGone\n',
          'sub000001.vtt': 'WEBVTT\n\n02:41.000 --> 02:42.000\nKept\n',
        },
        'hls',
      );

      // Segment 40 starts 160 seconds into the session.
      expect(await session.subtitleWindow(40)).toContain('Kept');

      session.onSegmentRequested('10.0.0.1', 'data000050.ts');
      await session.alignedSubtitlePlaylist();
      await vi.waitFor(
        async () => {
          expect(await fs.readdir(session.workingDirectory)).not.toContain(
            'sub000000.vtt',
          );
        },
        { timeout: 5000, interval: 10 },
      );
    });
  });

  describe('getLastSubtitleSegmentNumber (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns 0 when no .vtt segments exist', async () => {
      const session = makeSession(dir.name);
      await fs.mkdir(session.workingDirectory, { recursive: true });

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(0);
    });

    test('returns one past the highest existing .vtt segment number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      const result = await (
        session as unknown as {
          getLastSubtitleSegmentNumber(): Promise<number>;
        }
      ).getLastSubtitleSegmentNumber();

      expect(result).toBe(5);
    });
  });

  describe('deleteOldSegmentFiles (private)', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    async function callDeleteOldSegmentFiles(
      session: HlsSession,
      sequenceNum: number,
      extensions: string[],
    ) {
      return (
        session as unknown as {
          deleteOldSegmentFiles(
            sequenceNum: number,
            extensions: string[],
          ): Promise<void>;
        }
      ).deleteOldSegmentFiles(sequenceNum, extensions);
    }

    test('deletes .ts/.mp4 segments below the sequence number (regression)', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `data${String(n).padStart(6, '0')}.ts`),
          '',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.ts', '.mp4']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000003.ts', 'data000004.ts']);
    });

    test('deletes .vtt segments below the sequence number', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      for (const n of [0, 1, 2, 3, 4]) {
        await fs.writeFile(
          path.join(workingDir, `sub${String(n).padStart(6, '0')}.vtt`),
          'WEBVTT\n',
        );
      }

      await callDeleteOldSegmentFiles(session, 3, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['sub000003.vtt', 'sub000004.vtt']);
    });

    test('extensions filter is respected — .vtt deletion leaves .ts files untouched', async () => {
      const session = makeSession(dir.name);
      const workingDir = session.workingDirectory;
      await fs.mkdir(workingDir, { recursive: true });
      await fs.writeFile(path.join(workingDir, 'data000000.ts'), '');
      await fs.writeFile(path.join(workingDir, 'sub000000.vtt'), 'WEBVTT\n');

      await callDeleteOldSegmentFiles(session, 5, ['.vtt']);

      const remaining = await fs.readdir(workingDir);
      expect(remaining.sort()).toEqual(['data000000.ts']);
    });
  });

  describe('stop during program setup', () => {
    let tmpDir: tmp.DirResult;

    beforeEach(() => {
      tmpDir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      tmpDir.removeCallback();
    });

    // A stop that lands while the next program is still probing must not
    // leave a freshly spawned ffmpeg that nothing tracks (issue #1950).
    test('does not start a transcode once the session has stopped', async () => {
      let finishSetup: (value: Result<unknown>) => void = () => {};
      const setupDone = new Promise<Result<unknown>>((resolve) => {
        finishSetup = resolve;
      });

      const transcodeSession = {
        streamDuration: dayjs.duration(30, 'minutes'),
        kill: vi.fn(),
        wait: vi.fn(() => Promise.resolve({ code: 0, signal: null })),
        exited: Promise.resolve(),
      };
      const start = vi.fn(() => Promise.resolve());
      const programStream = {
        on: vi.fn(),
        setup: vi.fn(() => setupDone),
        start,
        renditions: undefined,
        transcodeSession,
      };

      const session = new HlsSession(
        {
          uuid: channelUuid,
          transcodeConfig: {},
        } as ChannelOrmWithTranscodeConfig,
        {
          streamMode: 'hls',
          initialSegmentCount: 2,
          transcodeDirectory: tmpDir.name,
        },
        {
          getCurrentLineupItem: vi.fn(() =>
            Promise.resolve(
              Result.success({
                lineupItem: { streamDuration: 1_800_000, duration: 1_800_000 },
                channelContext: {},
                sourceChannel: {},
              }),
            ),
          ),
        } as unknown as StreamProgramCalculator,
        {} as ISettingsDB,
        {
          getLiveTimestamp: vi.fn(() => Promise.resolve(Date.now())),
        } as unknown as OnDemandChannelService,
        (() => programStream as unknown as ProgramStream) as (
          ctx: PlayerContext,
          fmt: OutputFormat,
        ) => ProgramStream,
      );

      const internals = session as unknown as {
        startInternal(): Promise<void>;
      };
      await internals.startInternal();
      await vi.waitFor(() => expect(programStream.setup).toHaveBeenCalled());

      await session.stop({ waitForExit: false });
      expect(session.state).toBe('stopped');

      finishSetup(Result.success(transcodeSession));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(start).not.toHaveBeenCalled();
    });
  });
});

describe('HlsSession degradations (#68)', () => {
  test('each item reports its transcode degradations, keeping firstSeen while one continues', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const lowPower = (firstSeen: number) =>
        ({
          code: 'vaapi_low_power_unavailable',
          message: 'low power',
          firstSeen,
        }) as const;
      const perItem = [[lowPower(1)], [lowPower(2)], []];
      let item = 0;
      const programStreamFactory = () => {
        const transcodeSession = {
          streamDuration: dayjs.duration(1000),
          degradations: perItem[item++],
          wait: () => Promise.resolve(),
        };
        return {
          on: vi.fn(),
          setup: () => Promise.resolve(Result.success(transcodeSession)),
          start: () => Promise.resolve(),
          transcodeSession,
        } as unknown as ProgramStream;
      };
      const session = new HlsSession(
        {
          uuid: channelUuid,
          transcodeConfig: {},
        } as ChannelOrmWithTranscodeConfig,
        {
          streamMode: 'hls',
          initialSegmentCount: 2,
          transcodeDirectory: dir.name,
        },
        {
          getCurrentLineupItem: () =>
            Promise.resolve(
              Result.success({
                lineupItem: {},
                channelContext: {},
                sourceChannel: {},
              }),
            ),
        } as unknown as StreamProgramCalculator,
        {} as ISettingsDB,
        {
          getLiveTimestamp: () => Promise.resolve(0),
        } as unknown as OnDemandChannelService,
        programStreamFactory,
      );
      const internals = session as unknown as {
        transcode(realtime: boolean): Promise<void>;
        state: string;
      };
      internals.state = 'started';

      await internals.transcode(true);
      expect(session.degradations()).toEqual([lowPower(1)]);

      await internals.transcode(true);
      expect(session.degradations()).toEqual([lowPower(1)]);

      await internals.transcode(true);
      expect(session.degradations()).toEqual([]);
    } finally {
      dir.removeCallback();
    }
  });
});

describe('nextProgramPtsOffset', () => {
  test('starts the next audio where the previous audio ended', () => {
    // Audio ends 360 ticks after video, and AAC places its first packet 1920
    // ticks before the offset.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1083361, nonAudioEnd: 1083001 },
      1920,
    );

    expect(offset).toBe(1085282);
    expect(offset - 1920).toBe(1083361 + 1);
  });

  test('absorbs an audio shortfall up to the encoder lead without an audio gap', () => {
    // Audio ends 240 ticks before video. The lead still covers it.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1082761, nonAudioEnd: 1083001 },
      1920,
    );

    expect(offset - 1920).toBe(1082761 + 1);
  });

  test('never starts video before the previous video ended', () => {
    // The audio shortfall is larger than the lead, so video sets the offset.
    const offset = nextProgramPtsOffset(
      { audioEnd: 1080000, nonAudioEnd: 1083001 },
      480,
    );

    expect(offset).toBe(1083002);
  });

  test('uses the remaining stream when the segment has only one kind', () => {
    expect(nextProgramPtsOffset({ nonAudioEnd: 9000 }, 1920)).toBe(9001);
    expect(nextProgramPtsOffset({ audioEnd: 9000 }, 1920)).toBe(10921);
  });

  test('matches the old offset when there is no lead and audio ends first', () => {
    expect(nextProgramPtsOffset({ audioEnd: 8000, nonAudioEnd: 9000 }, 0)).toBe(
      9001,
    );
  });
});
