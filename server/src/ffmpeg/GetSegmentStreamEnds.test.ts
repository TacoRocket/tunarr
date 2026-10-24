import type * as ChildProcessModule from 'node:child_process';
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import {
  getFakeSettingsDb,
  setTestGlobalOptions,
} from '../testing/getFakeSettingsDb.js';
import {
  GetSegmentStreamEndsTask,
  parseSegmentStreamEnds,
} from './GetSegmentStreamEnds.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn(),
}));

beforeAll(async () => {
  await setTestGlobalOptions();
});

describe('HLS segment probe exit status', () => {
  test.each([0, 1])(
    'handles parseable output followed by exit %i',
    async (code) => {
      const child = new ChildProcess();
      const stdout = new PassThrough();
      child.stdout = stdout;
      vi.mocked(spawn).mockReturnValueOnce(child);

      const resultPromise = new GetSegmentStreamEndsTask(
        getFakeSettingsDb(),
      ).run('/test/segment.ts');
      stdout.end('video|90000|3000\n');
      await setImmediate();
      child.emit('close', code, null);
      const result = await resultPromise;

      if (code === 0) {
        expect(result.get()).toEqual({ nonAudioEnd: 93000 });
      } else {
        expect(result.isFailure()).toBe(true);
        if (result.isFailure()) {
          expect(result.error.cause?.message).toContain(
            'ffprobe exited with code 1',
          );
        }
      }
    },
  );
});

describe('parseSegmentStreamEnds', () => {
  test('tracks audio and video ends separately when video is the last packet written', () => {
    // From a real HLS segment: the muxer writes video last, but audio ends
    // 360 ticks (4 ms) later.
    const lines = [
      'audio|1079521|1920|',
      'video|1074001|3000',
      'audio|1081441|1920|',
      'video|1077001|3000',
      'video|1080001|3000',
    ];

    expect(parseSegmentStreamEnds(lines)).toEqual({
      audioEnd: 1083361,
      nonAudioEnd: 1083001,
    });
  });

  test('uses the latest end rather than the last packet of a stream', () => {
    // B-frames put packets out of presentation order.
    const lines = ['video|9000|3000', 'video|3000|3000'];

    expect(parseSegmentStreamEnds(lines)).toEqual({ nonAudioEnd: 12000 });
  });

  test('skips packets without a PTS', () => {
    const lines = ['video|6000|3000', 'video|N/A|3000', 'audio|N/A|1920'];

    expect(parseSegmentStreamEnds(lines)).toEqual({ nonAudioEnd: 9000 });
  });

  test('pads packets without a duration', () => {
    expect(parseSegmentStreamEnds(['audio|5000|N/A'])).toEqual({
      audioEnd: 15000,
    });
  });

  test('throws when no packet has a PTS', () => {
    expect(() => parseSegmentStreamEnds(['video|N/A|3000'])).toThrow(
      /No packet with a PTS found/,
    );
    expect(() => parseSegmentStreamEnds([])).toThrow(
      /No packet with a PTS found/,
    );
  });
});
