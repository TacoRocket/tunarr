import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { Result } from '@/types/result.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerContext } from './PlayerStreamContext.ts';
import type { ProgramStream } from './ProgramStream.ts';
import type { ProgramStreamFactory } from './ProgramStreamFactory.ts';
import type { SessionManager } from './SessionManager.ts';
import type { StreamProgramCalculator } from './StreamProgramCalculator.ts';

vi.mock('@/util/fsUtil.js', () => ({
  fileExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('./SessionManager.js', () => ({ SessionManager: vi.fn() }));
vi.mock('./StreamProgramCalculator.ts', () => ({
  StreamProgramCalculator: vi.fn(),
  StreamProgramCalculatorError: class extends Error {},
}));
const { VideoStream } = await import('./VideoStream.ts');

describe('VideoStream request reporting handoff', () => {
  it.each([false, true])(
    'preserves playback arguments and releases reports (startup fails: %s)',
    async (fails) => {
      const channel = {
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        transcodeConfig: {},
      };
      const getCurrentLineupItem = vi.fn().mockResolvedValue(
        Result.success({
          lineupItem: {
            type: 'offline',
            duration: 1000,
            streamDuration: 1000,
            programBeginMs: 123,
          },
          channelContext: channel,
          sourceChannel: channel,
        }),
      );
      const report = { requestId: 'request', update: vi.fn(), close: vi.fn() };
      const registerRequestReport = vi.fn().mockReturnValue(report);
      const current = Object.assign(new EventEmitter(), {
        degradations: [],
      }) as unknown as FfmpegTranscodeSession;
      const program = Object.assign(new EventEmitter(), {
        context: undefined as PlayerContext | undefined,
        start: vi.fn(async () => {
          if (fails) throw new Error('startup failed');
          program.emit('transcode', current);
        }),
        isInitialized: () => !fails,
        shutdown: vi.fn(),
      });
      const factory: ProgramStreamFactory = (context) => {
        program.context = context;
        return program as unknown as ProgramStream;
      };
      const video = new VideoStream(
        { getCurrentLineupItem } as unknown as StreamProgramCalculator,
        {
          getChannelOrm: vi.fn().mockResolvedValue(channel),
        } as unknown as IChannelDB,
        {
          ffmpegSettings: () => ({
            ffmpegExecutablePath: '/unused',
            hlsDirectOutputFormat: 'mpegts',
          }),
        } as ISettingsDB,
        factory,
        { registerRequestReport } as unknown as SessionManager,
      );
      const result = await video.startStream(
        {
          channel: channel.uuid,
          audioOnly: false,
          streamMode: 'mpegts',
          sessionToken: 'existing-playback-token',
          reportingSessionId: 'reporting-owner',
          connection: { ip: '127.0.0.1' },
        },
        123,
        true,
      );
      expect(getCurrentLineupItem).toHaveBeenCalledExactlyOnceWith({
        allowSkip: true,
        channelId: channel.uuid,
        startTime: 123,
        sessionToken: 'existing-playback-token',
      });
      expect(registerRequestReport).toHaveBeenCalledExactlyOnceWith(
        channel,
        'mpegts',
        'reporting-owner',
        {
          connection: { ip: '127.0.0.1' },
          programBeginMs: 123,
          programId: undefined,
        },
      );
      if (fails) {
        expect(result.type).toBe('error');
      } else {
        expect(report.update).toHaveBeenCalledWith([]);
        if (result.type !== 'success') throw new Error('Expected a stream');
        expect(program.shutdown).not.toHaveBeenCalled();
        result.stop();
      }
      expect(report.close).toHaveBeenCalledTimes(1);
      expect(program.shutdown).toHaveBeenCalledTimes(1);
      expect(program.listenerCount('transcode')).toBe(0);
    },
  );
});
