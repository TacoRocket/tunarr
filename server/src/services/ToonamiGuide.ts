import axios from 'axios';
import { z } from 'zod';
import type { Lineup } from '../db/derived_types/Lineup.ts';

type Feed = NonNullable<Lineup['liveRelay']>['feed'];

const ScheduleNames: Record<Feed, string> = {
  est: 'Toonami Aftermath EST',
  pst: 'Toonami Aftermath EST',
  'snick-est': 'Snickelodeon EST',
  'snick-pst': 'Snickelodeon EST',
  mtv97: 'MTV97',
  movies: 'Movies',
  radio: 'Toonami Aftermath Radio',
};

const ScheduleSchema = z.array(
  z.object({
    startDate: z.iso.datetime({ offset: true }),
    name: z.string().optional(),
    blockName: z.string().optional(),
    info: z
      .object({
        fullname: z.string().optional(),
        episode: z.string().optional(),
      })
      .nullish(),
  }),
);

export type LiveGuideEntry = {
  start: number;
  stop: number;
  title?: string;
  episode?: string;
};

function feedDelayMs(feed: Feed) {
  return feed === 'pst' || feed === 'snick-pst' ? 3 * 3_600_000 : 0;
}

export function toonamiGuideEntries(
  data: unknown,
  feed: Feed,
  from: number,
  to: number,
): LiveGuideEntry[] {
  const schedule = ScheduleSchema.parse(data);
  const delay = feedDelayMs(feed);
  const entries: LiveGuideEntry[] = [];
  let cursor = from;
  for (let i = 0; i < schedule.length - 1; i++) {
    const item = schedule[i];
    const next = schedule[i + 1];
    if (!item || !next) continue;
    const start = Date.parse(item.startDate) + delay;
    if (start >= to) break;
    const stop = Date.parse(next.startDate) + delay;
    if (stop <= start) throw new Error('Toonami schedule is not chronological');
    if (stop <= from) continue;
    if (start > cursor) entries.push({ start: cursor, stop: start });
    entries.push({
      start: Math.max(from, start),
      stop: Math.min(to, stop),
      title:
        item.info?.fullname?.trim() ||
        item.name?.trim() ||
        item.blockName?.trim(),
      episode: item.info?.episode?.trim() || undefined,
    });
    cursor = Math.min(to, stop);
  }
  // The provider supplies starts, not durations. Never invent the last show's
  // end or repeat a finite schedule to fill a longer requested guide window.
  if (cursor < to) entries.push({ start: cursor, stop: to });
  return entries;
}

export async function getToonamiGuide(feed: Feed, from: number, to: number) {
  const response = await axios.get<unknown>(
    'https://api.toonamiaftermath.com/media',
    {
      params: {
        scheduleName: ScheduleNames[feed],
        dateString: new Date(from - feedDelayMs(feed)).toISOString(),
        count: 75,
      },
      timeout: 10_000,
      maxContentLength: 2 * 1024 * 1024,
    },
  );
  // Some feeds (including Radio) return an empty body rather than a schedule.
  return toonamiGuideEntries(
    response.data === '' ? [] : response.data,
    feed,
    from,
    to,
  );
}
