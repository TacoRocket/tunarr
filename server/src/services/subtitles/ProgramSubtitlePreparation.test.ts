import '../../container.ts';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Result } from '../../types/result.ts';
import { ProgramSubtitlePreparation } from './ProgramSubtitlePreparation.ts';

it('continues acquisition when playback rejected the existing commentary text', async () => {
  const doGet = vi.fn(async () => ({
    MediaContainer: {
      Stream: ['1', '2'].map((id) => ({
        id,
        streamType: 3,
        codec: 'srt',
        languageCode: 'eng',
        hearingImpaired: false,
        forced: false,
      })),
    },
  }));
  const job = new ProgramSubtitlePreparation(
    {
      getProgramById: async () => ({
        uuid: 'program',
        state: 'ok',
        mediaSourceId: 'source',
        externalKey: '1',
      }),
    } as never,
    { getById: async () => ({ type: 'plex' }) } as never,
    {
      getStream: async () =>
        Result.success({
          streamSource: { type: 'http', path: 'http://localhost/movie.mkv' },
          streamDetails: {
            subtitleDetails: [
              {
                type: 'external',
                codec: 'srt',
                title: 'Commentary',
                path: '/commentary.srt',
                languageCodeISO6392: 'eng',
                sdh: false,
                forced: false,
              },
            ],
          },
        }),
    } as never,
    {
      getSubtitleCacheFolder: () =>
        path.join(os.tmpdir(), `tunarr-unused-subtitles-${randomUUID()}`),
    } as never,
    { getPlexApiClientForMediaSource: async () => ({ doGet }) } as never,
    {} as never,
    {} as never,
  );
  const request = { programId: 'program', sdh: false };

  expect(await job.prepare(request)).toMatchObject({
    status: 'existing-text-track',
    path: '/commentary.srt',
  });
  expect(doGet).not.toHaveBeenCalled();
  expect(
    await job.prepare(request, { reuseExistingText: false }),
  ).toMatchObject({ status: 'needs-selection', provider: 'plex' });
  expect(doGet).toHaveBeenCalledOnce();
});
