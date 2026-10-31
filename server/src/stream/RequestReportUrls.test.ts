import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FFmpegAssistedFactory } from '@/ffmpeg/FFmpegModule.js';
import { Result } from '@/types/result.js';
import dayjs from '@/util/dayjs.js';
import { describe, expect, it, vi } from 'vitest';
import { ConcatStream } from './ConcatStream.ts';
import type { StreamProgramCalculator } from './StreamProgramCalculator.ts';
import { HlsPlaylistCreator } from './hls/HlsPlaylistCreator.ts';

vi.mock('@/globals.js', () => ({ serverOptions: () => ({ port: 8000 }) }));

describe('report ownership URLs', () => {
  it.each(['mpegts_concat', 'hls_direct_concat'] as const)(
    'carries %s ownership without setting a playback token',
    async (mode) => {
      const createConcatSession = vi.fn();
      const factory = (() => ({
        createConcatSession,
      })) as unknown as FFmpegAssistedFactory;
      const stream = new ConcatStream(
        {
          uuid: 'channel',
          transcodeConfig: {},
        } as ChannelOrmWithTranscodeConfig,
        mode,
        factory,
      );
      await stream.createSession('owner-instance');
      const url = new URL(createConcatSession.mock.calls[0][0]);
      expect(url.searchParams.get('reportingSessionId')).toBe('owner-instance');
      expect(url.searchParams.has('token')).toBe(false);
    },
  );

  it('preserves the Direct v1 media URL and adds only owner correlation for an internal playlist', async () => {
    const calculator = {
      getCurrentLineupItem: vi.fn().mockResolvedValue(
        Result.success({
          lineupItem: {
            type: 'offline',
            programBeginMs: 0,
            duration: 1000,
            streamDuration: 1000,
          },
        }),
      ),
    } as unknown as StreamProgramCalculator;
    const creator = new HlsPlaylistCreator(calculator);
    const request = {
      protocol: 'http',
      host: 'localhost:8000',
      channelIdOrNumber: 'channel',
      streamMode: 'hls_direct' as const,
      outputFormat: 'mpegts' as const,
    };
    const direct = await creator.createPlaylist('channel', dayjs(0), request);
    const internal = await creator.createPlaylist('channel', dayjs(0), {
      ...request,
      reportingSessionId: 'owner-instance',
    });
    expect(internal.replace('&reportingSessionId=owner-instance', '')).toBe(
      direct,
    );
    expect(internal).not.toContain('&token=');
  });
});
