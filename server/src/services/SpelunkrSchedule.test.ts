import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { getSpelunkrGuide } from './SpelunkrSchedule.ts';

afterEach(() => vi.restoreAllMocks());

it('keeps the channel visible under its name when the first schedule load fails', async () => {
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
  expect(
    await getSpelunkrGuide('happy-trees', now, to, 'My Spelunkr Channel'),
  ).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(1);
});
