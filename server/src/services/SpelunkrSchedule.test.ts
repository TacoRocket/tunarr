import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

afterEach(() => vi.restoreAllMocks());

it('keeps the channel visible under its name when the first schedule load fails', async () => {
  const { getSpelunkrGuide } = await import('./SpelunkrSchedule.ts');
  const request = vi
    .spyOn(axios, 'get')
    .mockRejectedValue(new Error('Provider unavailable'));
  const now = Date.parse('2026-11-01T20:00:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const to = now + 48 * 3_600_000;
  const expected = [{ start: now, stop: to, title: 'My Spelunkr Channel' }];

  expect(
    await getSpelunkrGuide('happy-trees', now, to, 'My Spelunkr Channel'),
  ).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['lineup', 'manifest'])(
  'allows playback after the guide %s fetch failed',
  async (failure) => {
    const { getSpelunkrGuide, getSpelunkrSchedule, getSpelunkrPlaybackEntry } =
      await import('./SpelunkrSchedule.ts');
    const now = Date.parse('2026-11-01T20:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const request = vi.spyOn(axios, 'get');
    if (failure === 'manifest') {
      request.mockResolvedValueOnce({
        data: {
          channels: [
            {
              id: 'happy-trees',
              versions: [
                {
                  v: 2,
                  manifest: 'manifests/happy-trees/v2.json',
                  epochMs: now,
                  effectiveAtMs: now,
                  startIndex: 0,
                },
              ],
            },
          ],
        },
      });
    }
    request
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValueOnce({
        data: {
          channels: [
            {
              id: 'happy-trees',
              versions: [
                {
                  v: 1,
                  manifest: 'manifests/happy-trees/v1.json',
                  epochMs: now,
                  effectiveAtMs: now,
                  startIndex: 0,
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          engine: 5,
          channel: 'happy-trees',
          version: 1,
          platform: 'platform/0123456789abcdef.json',
          items: [
            {
              id: 'test-episode',
              file: 'episode.mp4',
              title: 'Episode',
              duration: 1800,
            },
          ],
          bumps: [{ id: 'station', slides: [{ text: 'Break' }] }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          engine: 1,
          bumps: [{ id: 'platform', slides: [{ text: 'Break' }] }],
        },
      });

    expect(
      await getSpelunkrGuide('happy-trees', now, now + 3600000, 'My Channel'),
    ).toEqual([{ start: now, stop: now + 3600000, title: 'My Channel' }]);
    const entry = await getSpelunkrPlaybackEntry('happy-trees', now + 20000);
    expect(entry).toMatchObject({
      startMs: now,
      endMs: now + 1800000,
      source: {
        uri: 'https://archive.org/download/test-episode/episode.mp4',
        inPointMs: 0,
      },
    });
    expect((await getSpelunkrSchedule('happy-trees')).at(now + 20000)).toEqual(
      entry,
    );
    expect(request).toHaveBeenCalledTimes(failure === 'manifest' ? 5 : 4);
  },
);

it.each([true, false])(
  'refreshes an unusable cached playback entry once (provider recovers: %s)',
  async (recovers) => {
    const { getSpelunkrSchedule, getSpelunkrPlaybackEntry } = await import(
      './SpelunkrSchedule.ts'
    );
    const now = Date.parse('2026-11-01T20:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const lineup = (epoch: number) => ({
      channels: [
        {
          id: 'happy-trees',
          versions: [
            {
              v: 1,
              manifest: 'manifests/happy-trees/v1.json',
              epochMs: epoch,
              effectiveAtMs: epoch,
              startIndex: 0,
            },
          ],
        },
      ],
    });
    const manifest = {
      engine: 5,
      channel: 'happy-trees',
      version: 1,
      platform: 'platform/0123456789abcdef.json',
      items: [
        {
          id: 'test-episode',
          file: 'episode.mp4',
          title: 'Episode',
          duration: 1800,
        },
      ],
      bumps: [{ id: 'station', slides: [{ text: 'Break' }] }],
    };
    const platform = {
      engine: 1,
      bumps: [{ id: 'platform', slides: [{ text: 'Break' }] }],
    };
    const request = vi
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: lineup(now + 3600000) })
      .mockResolvedValueOnce({ data: manifest })
      .mockResolvedValueOnce({ data: platform });
    const cached = await getSpelunkrSchedule('happy-trees');
    expect(() => cached.at(now)).toThrow(
      'No Spelunkr schedule published for this time',
    );
    clock.mockReturnValue(now + 20000);
    if (recovers) {
      request
        .mockResolvedValueOnce({ data: lineup(now) })
        .mockResolvedValueOnce({ data: manifest })
        .mockResolvedValueOnce({ data: platform });
      const entry = await getSpelunkrPlaybackEntry('happy-trees', now + 20000);
      expect(entry.startMs).toBe(now);
      expect(entry.endMs).toBe(now + 1800000);
      expect(entry.source?.uri).toBe(
        'https://archive.org/download/test-episode/episode.mp4',
      );
      const later = await getSpelunkrPlaybackEntry('happy-trees', now + 40000);
      expect(later).toEqual(entry);
      expect(request).toHaveBeenCalledTimes(6);
    } else {
      request.mockRejectedValue(new Error('Provider unavailable'));
      await expect(
        getSpelunkrPlaybackEntry('happy-trees', now + 20000),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(4);
    }
  },
);
