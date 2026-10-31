import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FFmpegAssistedFactory } from '@/ffmpeg/FFmpegModule.js';
import type { StreamProgramCalculator } from '@/stream/StreamProgramCalculator.js';
import { Result } from '@/types/result.js';
import dayjs from 'dayjs';
import { describe, expect, test, vi } from 'vitest';
import type { ProgramStream } from '../ProgramStream.ts';
import { HlsSlowerSession } from './HlsSlowerSession.ts';

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

vi.mock('@/stream/ConnectionTracker.ts', () => ({
  ConnectionTracker: class {
    on = vi.fn();
  },
}));

describe('HlsSlowerSession degradations (#68)', () => {
  test('reports the degradations of the item it just set up', async () => {
    const degradation = {
      code: 'subtitle_passthrough_unsupported',
      message: 'The selected image subtitle cannot be shown in passthrough.',
      firstSeen: 1,
    } as const;
    const transcodeSession = {
      streamDuration: dayjs.duration(1000),
      degradations: [degradation],
    };
    const session = new HlsSlowerSession(
      {
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        transcodeConfig: {},
      } as ChannelOrmWithTranscodeConfig,
      { initialSegmentCount: 2, transcodeDirectory: '/tmp/unused' },
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
      () =>
        ({
          on: vi.fn(),
          setup: () => Promise.resolve(Result.success(transcodeSession)),
        }) as unknown as ProgramStream,
      {} as FFmpegAssistedFactory,
    );

    await session.getNextItemStream({
      startTime: Date.now(),
      audioOnly: false,
    } as Parameters<HlsSlowerSession['getNextItemStream']>[0]);

    expect(session.degradations()).toEqual([degradation]);
  });
});
