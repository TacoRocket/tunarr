import { SpelunkrFeedSchema } from '@tunarr/types/schemas';
import axios from 'axios';
import { z } from 'zod';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import type { LiveGuideEntry } from './ToonamiGuide.ts';

export type SpelunkrFeed = z.infer<typeof SpelunkrFeedSchema>;

const FeedTitles: Record<SpelunkrFeed, string> = {
  'computer-chronicles': 'Computer Chronicles',
  'happy-trees': 'Happy Trees',
};
const MetadataBase = 'https://data.spelunkr.tv/';
const CacheMs = 6 * 3_600_000;
const GuideWindowMs = 12 * 3_600_000;
const logger = LoggerFactory.child({ className: 'SpelunkrSchedule' });
const MaxCycles = 256;
const MaxGuideMs = 14 * 86_400_000;
const Milliseconds = z.number().int().nonnegative().safe();
const VersionSchema = z.object({
  v: z.number().int().positive(),
  manifest: z.string(),
  epochMs: Milliseconds,
  effectiveAtMs: Milliseconds,
  startIndex: z.number().int().nonnegative(),
});
const BumpSchema = z.object({
  id: z.string().min(1).max(200),
  active: z.boolean().optional(),
  date_range: z.tuple([z.string(), z.string()]).optional(),
  slides: z
    .array(z.object({ text: z.string().max(4096) }))
    .min(1)
    .max(40),
});
const ItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  file: z.string().min(1).max(2048).optional(),
  mp4: z.string().min(1).max(2048).optional(),
  title: z.string().min(1).max(1024),
  duration: z.number().int().positive().max(86_400),
  inS: z.number().int().nonnegative().optional(),
  outS: z.number().int().positive().optional(),
});
const ManifestSchema = z.object({
  engine: z.literal(5),
  channel: SpelunkrFeedSchema,
  version: z.number().int(),
  items: z.array(ItemSchema).min(1).max(1000),
  bumps: z.array(BumpSchema).min(1).max(500),
  platform: z.string().regex(/^platform\/[a-f0-9]{16,64}\.json$/),
  ads: z.never().optional(),
  block: z.never().optional(),
  audioOverlay: z.literal(false).optional(),
});
const PlatformSchema = z.object({
  engine: z.literal(1),
  bumps: z.array(BumpSchema).min(1).max(500),
});
type Bump = z.infer<typeof BumpSchema>;
type Version = z.infer<typeof VersionSchema>;
type Manifest = z.infer<typeof ManifestSchema>;

export type SpelunkrScheduleEntry = {
  startMs: number;
  endMs: number;
  title: string;
  source?: { uri: string; inPointMs: number };
};
export type SpelunkrSchedule = {
  at(timeMs: number): SpelunkrScheduleEntry;
  entries(fromMs: number, toMs: number): SpelunkrScheduleEntry[];
};

// Spelunkr engine 5 uses a signed Java-style string hash and Mulberry32 to
// seed its Fisher–Yates bumper decks. These values are part of the broadcast
// clock: selecting a different text card changes the length of the break.
function randomFor(seed: string) {
  let state = 0;
  for (let i = 0; i < seed.length; i++) {
    state = (Math.imul(state, 31) + seed.charCodeAt(i)) | 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function inSeason(bump: Bump, timeMs: number) {
  if (!bump.date_range) return true;
  const [from, to] = bump.date_range;
  if (/^\d{4}-/.test(from)) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T23:59:59.999Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new Error('Invalid Spelunkr bumper season');
    return timeMs >= start && timeMs <= end;
  }
  if (![from, to].every((date) => /^\d{2}-\d{2}$/.test(date)))
    throw new Error('Unsupported Spelunkr bumper season');
  const date = new Date(timeMs);
  const day = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const start = Number(from.replace('-', ''));
  const end = Number(to.replace('-', ''));
  return start <= end ? day >= start && day <= end : day >= start || day <= end;
}

function eligible(bumps: Bump[], timeMs: number) {
  return bumps.filter(
    (bump) => bump.active !== false && inSeason(bump, timeMs),
  );
}

function shuffleDeck(bumps: Bump[], recent: Bump[], seed: string) {
  const random = randomFor(seed);
  const deck = [...bumps];
  for (let index = deck.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [deck[index], deck[other]] = [deck[other]!, deck[index]!];
  }
  const separation = Math.floor(deck.length / 2);
  const earliest = new Map<Bump, number>();
  const lookback = Math.min(separation, recent.length);
  for (let age = lookback; age >= 1; age--) {
    earliest.set(recent[recent.length - age]!, separation + 1 - age);
  }
  for (let age = 1; age <= lookback; age++) {
    const previous = recent[recent.length - age]!;
    const position = deck.indexOf(previous);
    const floor = earliest.get(previous)!;
    if (position < 0 || position >= floor) continue;
    const replacements = deck.flatMap((bump, index) =>
      index >= floor && (earliest.get(bump) ?? 0) <= position ? [index] : [],
    );
    const other = replacements[Math.floor(random() * replacements.length)];
    if (other === undefined)
      throw new Error('Spelunkr bumper deck cannot preserve repeat spacing');
    [deck[position], deck[other]] = [deck[other]!, deck[position]!];
  }
  return deck;
}

type Deck = {
  order: Bump[];
  position: number;
  season: string | null;
  recent: Bump[];
};
const emptyDeck = (): Deck => ({
  order: [],
  position: 0,
  season: null,
  recent: [],
});
const textDuration = (bump: Bump) =>
  bump.slides.reduce(
    (total, slide) => total + Math.max(2500, 1500 + slide.text.length * 55),
    0,
  );

function versionClock(
  version: Version,
  manifest: Manifest,
  platform: Bump[],
  feed: SpelunkrFeed,
) {
  if (
    manifest.channel !== feed ||
    manifest.version !== version.v ||
    version.startIndex >= manifest.items.length
  ) {
    throw new Error('Spelunkr version pointer does not match its manifest');
  }
  for (const item of manifest.items) {
    if (
      !(item.file || item.mp4) ||
      (item.outS !== undefined && item.outS - (item.inS ?? 0) !== item.duration)
    ) {
      throw new Error(
        'Spelunkr video has no file or inconsistent trim duration',
      );
    }
  }
  let cycle = 0;
  let cursor = version.epochMs;
  let deck = emptyDeck();
  let current: SpelunkrScheduleEntry[] = [];
  function buildCycle() {
    if (cycle >= MaxCycles)
      throw new Error('Spelunkr schedule exceeds the supported cycle window');
    const seed = `${version.v}.${cycle}`;
    const firstIndex = cycle === 0 ? version.startIndex : 0;
    let rounds = 0;
    current = [];
    for (let index = firstIndex; index < manifest.items.length; index++) {
      const item = manifest.items[index]!;
      const startMs = cursor;
      cursor += item.duration * 1000;
      current.push({
        startMs,
        endMs: cursor,
        title: item.title,
        source: {
          uri: `https://archive.org/download/${item.id}/${encodeURIComponent((item.file || item.mp4)!)}`,
          inPointMs: (item.inS ?? 0) * 1000,
        },
      });
      const available = eligible(manifest.bumps, cursor);
      const platformAvailable = eligible(platform, cursor);
      if (!available.length || !platformAvailable.length) continue;
      const season = available
        .filter((bump) => bump.date_range)
        .map((bump) => bump.id)
        .join('|');
      if (deck.season !== season || deck.position >= deck.order.length) {
        deck.order = shuffleDeck(
          available,
          deck.recent,
          `${feed}-deck-${seed}-${rounds++}`,
        );
        deck.position = 0;
        deck.season = season;
      }
      const selected = deck.order[deck.position++]!;
      deck.recent.push(selected);
      if (deck.recent.length > deck.order.length) deck.recent.shift();
      const platformIndex = Math.floor(
        randomFor(`spelunkr-break-${index}-${seed}`)() *
          platformAvailable.length,
      );
      const platformBump = platformAvailable[platformIndex]!;
      const breakStart = cursor;
      cursor += 7800 + textDuration(selected) + textDuration(platformBump);
      current.push({
        startMs: breakStart,
        endMs: cursor,
        title: `${FeedTitles[feed]} — break`,
      });
    }
    cycle++;
  }
  return (timeMs: number) => {
    if (timeMs < version.epochMs)
      throw new Error('Spelunkr schedule predates its published epoch');
    if (current.length && timeMs < current[0]!.startMs) {
      cycle = 0;
      cursor = version.epochMs;
      deck = emptyDeck();
      current = [];
    }
    while (!current.length || timeMs >= cursor) buildCycle();
    const entry = current.find(
      (candidate) => timeMs >= candidate.startMs && timeMs < candidate.endMs,
    );
    if (!entry) throw new Error('Spelunkr schedule has a gap');
    return entry;
  };
}

export function createSpelunkrSchedule(
  data: { pointer: unknown; manifest: unknown; platform: unknown }[],
  feed: SpelunkrFeed = 'computer-chronicles',
): SpelunkrSchedule {
  if (!data.length || data.length > 8)
    throw new Error('Unsupported Spelunkr version count');
  const versions = data
    .map((input) => {
      const pointer = VersionSchema.parse(input.pointer);
      return {
        pointer,
        at: versionClock(
          pointer,
          ManifestSchema.parse(input.manifest),
          PlatformSchema.parse(input.platform).bumps,
          feed,
        ),
      };
    })
    .sort((a, b) => a.pointer.v - b.pointer.v);
  const at = (timeMs: number) => {
    if (!Number.isSafeInteger(timeMs))
      throw new Error('Invalid Spelunkr schedule timestamp');
    const version = versions.findLast(
      (candidate) => candidate.pointer.effectiveAtMs <= timeMs,
    );
    if (!version)
      throw new Error('No Spelunkr schedule published for this time');
    const entry = version.at(timeMs);
    const next = versions.filter(
      (candidate) =>
        candidate.pointer.v > version.pointer.v &&
        candidate.pointer.effectiveAtMs > timeMs,
    );
    return {
      ...entry,
      endMs: Math.min(
        entry.endMs,
        ...next.map((candidate) => candidate.pointer.effectiveAtMs),
      ),
    };
  };
  return {
    at,
    entries(fromMs, toMs) {
      if (
        !Number.isSafeInteger(toMs) ||
        toMs < fromMs ||
        toMs - fromMs > MaxGuideMs
      )
        throw new Error('Unsupported Spelunkr guide window');
      const entries: SpelunkrScheduleEntry[] = [];
      for (let cursor = fromMs; cursor < toMs; ) {
        const entry = at(cursor);
        entries.push(entry);
        cursor = entry.endMs;
      }
      return entries;
    },
  };
}

async function metadata(path: string) {
  const response = await axios.get<unknown>(MetadataBase + path, {
    timeout: 10_000,
    maxContentLength: 2 * 1024 * 1024,
    maxRedirects: 0,
    headers: {
      'User-Agent': 'Tunarr',
    },
  });
  return response.data;
}
const LineupSchema = z.object({
  channels: z
    .array(z.object({ id: z.string(), versions: z.unknown().optional() }))
    .max(200),
});
type Lineup = z.infer<typeof LineupSchema>;
let lastLineup: Lineup | undefined;
let lineupRequest: { until: number; result: Promise<Lineup> } | undefined;

function getLineup() {
  if (!lineupRequest || lineupRequest.until <= Date.now()) {
    const result = metadata('lineup.json')
      .then((data) => {
        lastLineup = LineupSchema.parse(data);
        return lastLineup;
      })
      .catch((error: unknown) => {
        if (!lastLineup) throw error;
        logger.warn(
          error,
          'Spelunkr lineup refresh failed; retaining cached data',
        );
        return lastLineup;
      });
    // Share pending and failed checks too: channel changes must not cause a
    // burst of metadata requests while the provider is unavailable.
    lineupRequest = { until: Date.now() + CacheMs, result };
  }
  return lineupRequest;
}

const schedules = new Map<
  SpelunkrFeed,
  { pointers: string; schedule: SpelunkrSchedule }
>();
const requests = new Map<
  SpelunkrFeed,
  { until: number; result: Promise<SpelunkrSchedule> }
>();

export async function getSpelunkrSchedule(
  feed: SpelunkrFeed = 'computer-chronicles',
): Promise<SpelunkrSchedule> {
  const existing = requests.get(feed);
  if (existing && existing.until > Date.now()) return existing.result;
  const lineup = getLineup();
  const cached = schedules.get(feed);
  const result = (async () => {
    const channel = (await lineup.result).channels.find(
      (candidate) => candidate.id === feed,
    );
    const versions = z
      .array(VersionSchema)
      .min(1)
      .max(8)
      .parse(channel?.versions);
    for (const version of versions) {
      if (version.manifest !== `manifests/${feed}/v${version.v}.json`)
        throw new Error('Unsupported Spelunkr manifest location');
    }
    const pointers = JSON.stringify(versions);
    if (cached?.pointers === pointers) return cached.schedule;
    const inputs = await Promise.all(
      versions.map(async (pointer) => {
        const manifest = ManifestSchema.parse(await metadata(pointer.manifest));
        const platform = await metadata(manifest.platform);
        return { pointer, manifest, platform };
      }),
    );
    const schedule = createSpelunkrSchedule(inputs, feed);
    schedules.set(feed, { pointers, schedule });
    return schedule;
  })().catch((error: unknown) => {
    if (!cached) throw error;
    logger.warn(
      { err: error, feed },
      'Spelunkr schedule refresh failed; retaining cached schedule',
    );
    return cached.schedule;
  });
  requests.set(feed, { until: lineup.until, result });
  return result;
}

export async function getSpelunkrGuide(
  feed: SpelunkrFeed,
  from: number,
  to: number,
  channelName: string,
  now = Date.now(),
): Promise<LiveGuideEntry[]> {
  const detailedEnd = Math.max(from, Math.min(to, now + GuideWindowMs));
  const entries: LiveGuideEntry[] = [];
  if (from < detailedEnd) {
    try {
      const schedule = await getSpelunkrSchedule(feed);
      entries.push(
        ...schedule.entries(from, detailedEnd).map((entry) => ({
          start: Math.max(from, entry.startMs),
          stop: Math.min(detailedEnd, entry.endMs),
          title: entry.source ? entry.title : "We'll Be Right Back",
        })),
      );
    } catch (error) {
      logger.warn(
        { err: error, feed },
        'Spelunkr guide unavailable; using channel name',
      );
      return [{ start: from, stop: to, title: channelName }];
    }
  }
  if (detailedEnd < to) {
    entries.push({ start: detailedEnd, stop: to, title: channelName });
  }
  return entries;
}
