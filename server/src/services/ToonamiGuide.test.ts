import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { getToonamiGuide, toonamiGuideEntries } from './ToonamiGuide.ts';

afterEach(() => vi.restoreAllMocks());

const media = [
  {
    name: 'Digimon',
    startDate: '2026-11-01T15:00:45.547Z',
    info: { episode: 'Trash Day' },
  },
  { name: 'Monster Rancher', startDate: '2026-11-01T15:24:47.810Z' },
  { name: 'Yu-Gi-Oh!', startDate: '2026-11-01T15:49:46.125Z' },
];

it('replaces the West placeholder with provider titles at the delayed broadcast times', async () => {
  const request = vi.spyOn(axios, 'get').mockResolvedValue({ data: media });
  const from = Date.parse('2026-11-01T18:00:00Z');
  const to = Date.parse('2026-11-01T19:00:00Z');
  const guide = await getToonamiGuide('pst', from, to);
  expect(request).toHaveBeenCalledWith(
    'https://api.toonamiaftermath.com/media',
    expect.objectContaining({
      params: {
        scheduleName: 'Toonami Aftermath EST',
        dateString: '2026-11-01T15:00:00.000Z',
        count: 75,
      },
    }),
  );
  expect(guide).toEqual([
    { start: from, stop: Date.parse('2026-11-01T18:00:45.547Z') },
    {
      start: Date.parse('2026-11-01T18:00:45.547Z'),
      stop: Date.parse('2026-11-01T18:24:47.810Z'),
      title: 'Digimon',
      episode: 'Trash Day',
    },
    {
      start: Date.parse('2026-11-01T18:24:47.810Z'),
      stop: Date.parse('2026-11-01T18:49:46.125Z'),
      title: 'Monster Rancher',
      episode: undefined,
    },
    { start: Date.parse('2026-11-01T18:49:46.125Z'), stop: to },
  ]);
  const east = toonamiGuideEntries(
    media,
    'est',
    from - 3 * 3_600_000,
    to - 3 * 3_600_000,
  );
  expect(east[1]?.title).toBe(guide[1]?.title);
  expect(east[1]?.start).toBe(Date.parse('2026-11-01T15:00:45.547Z'));
});

it('keeps placeholder coverage when a feed returns the observed empty schedule response', async () => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: '' });
  expect(await getToonamiGuide('radio', 0, 3_600_000)).toEqual([
    { start: 0, stop: 3_600_000 },
  ]);
});

it('does not discard today’s guide because the provider returns unordered entries beyond the requested window', () => {
  const schedule = [
    ...media,
    { name: 'Brak Show', startDate: '2026-11-02T19:26:47.857Z' },
    { name: 'X-Men', startDate: '2026-11-02T17:00:30.231Z' },
  ];
  const from = Date.parse('2026-11-01T15:00:00Z');
  const to = Date.parse('2026-11-01T15:49:46.125Z');
  expect(
    toonamiGuideEntries(schedule, 'est', from, to).map((entry) => entry.title),
  ).toEqual([undefined, 'Digimon', 'Monster Rancher']);
});
