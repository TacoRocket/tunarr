import type { SaveableChannel } from '@tunarr/types';
import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { bootstrapTunarr } from '../bootstrap.ts';
import { MaterializeLineupCommand } from '../commands/MaterializeLineupCommand.ts';
import { ChannelDB } from '../db/ChannelDB.ts';
import { BasicChannelRepository } from '../db/channel/BasicChannelRepository.ts';
import { ChannelConfigRepository } from '../db/channel/ChannelConfigRepository.ts';
import { ChannelProgramRepository } from '../db/channel/ChannelProgramRepository.ts';
import { ChannelReadOpsRepository } from '../db/channel/ChannelReadOpsRepository.ts';
import { LineupRepository } from '../db/channel/LineupRepository.ts';
import { ProgramConverter } from '../db/converters/ProgramConverter.ts';
import { DBAccess } from '../db/DBAccess.ts';
import { ProgramStateRepository } from '../db/program/ProgramStateRepository.ts';
import { globalOptions, setGlobalOptions } from '../globals.ts';
import { copyPreMigratedDb } from '../testing/testDbFactory.ts';
import { Result } from '../types/result.ts';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import { mock } from 'ts-mockito';
import { CacheImageService } from './cacheImageService.ts';
import { FileSystemService } from './FileSystemService.ts';
import type { MeilisearchService } from './MeilisearchService.ts';
import { ChannelProgramDurationService } from './scheduling/ChannelProgramDurationService.ts';
import {
  FileTables,
  TrashRepairService,
  UsageTables,
} from './TrashRepairService.ts';

// The real scheduler and guide task load most of the server, which is slow
// enough to time out the first test on CI.
const { runXmlTvNow } = vi.hoisted(() => ({
  runXmlTvNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./Scheduler.ts', () => ({
  GlobalScheduler: {
    getScheduledJob: () => ({ runNow: runXmlTvNow }),
  },
}));

vi.mock('../tasks/UpdateXmlTvTask.ts', () => ({
  UpdateXmlTvTask: { ID: 'UpdateXmlTvTask' },
}));

type Harness = {
  sqlite: Database.Database;
  channelDb: ChannelDB;
  lineups: LineupRepository;
  service: TrashRepairService;
  settings: { repairReaddedItems: boolean };
  deleteByIds: ReturnType<typeof vi.fn>;
  reconcileRuns: unknown[];
  transcodeConfigId: string;
};

let dir: tmp.DirectoryResult;
let h: Harness;

// Bootstrapping opens the database once per test file, so the tests share it
// and keep apart with fresh IDs; trashed programs are cleared after each test.
beforeAll(async () => {
  dir = await tmp.dir({ unsafeCleanup: true });
  await copyPreMigratedDb(dir.path);
  setGlobalOptions({ database: dir.path, log_level: 'error', verbose: 0 });
  await bootstrapTunarr();
  const db = DBAccess.instance.db!;
  const drizzle = DBAccess.instance.drizzle!;
  const sqlite = DBAccess.instance.getConnection(`${dir.path}/db.db`)!.sqlite;

  const readOps = new ChannelReadOpsRepository(drizzle);
  const channelPrograms = new ChannelProgramRepository(db, drizzle);
  const lineups = new LineupRepository(
    db,
    drizzle,
    new FileSystemService(globalOptions()),
    (() => ({})) as never,
    { execute: async () => ({}) } as unknown as MaterializeLineupCommand,
    { execute: async () => [] } as never,
    new ProgramConverter(LoggerFactory.child({ className: 'test' }), db),
    readOps,
    new ChannelProgramDurationService(drizzle),
    channelPrograms,
  );
  const channelDb = new ChannelDB(
    new BasicChannelRepository(
      db,
      drizzle,
      mock(CacheImageService),
      readOps,
      lineups,
    ),
    channelPrograms,
    lineups,
    new ChannelConfigRepository(db),
    readOps,
  );

  const settings = {
    repairReaddedItems: true,
    repairReaddedItemsOnStartup: false,
  };
  const deleteByIds = vi.fn().mockResolvedValue(undefined);
  const reconcileRuns: unknown[] = [];
  const service = new TrashRepairService(
    drizzle,
    lineups,
    new ProgramStateRepository(drizzle),
    { deleteByIds } as unknown as MeilisearchService,
    {
      globalMediaSourceSettings: () => ({
        rescanIntervalHours: 6,
        ...settings,
      }),
    } as never,
    () =>
      ({
        run: (request: unknown) => {
          reconcileRuns.push(request);
          return Promise.resolve(Result.success(undefined));
        },
      }) as never,
  );

  const config = sqlite
    .prepare('SELECT uuid FROM transcode_config WHERE is_default = 1')
    .get() as { uuid: string };
  h = {
    sqlite,
    channelDb,
    lineups,
    service,
    settings,
    deleteByIds,
    reconcileRuns,
    transcodeConfigId: config.uuid,
  };
});

afterEach(() => {
  h.sqlite.prepare("DELETE FROM program WHERE state <> 'ok'").run();
  h.settings.repairReaddedItems = true;
  h.settings.repairReaddedItemsOnStartup = false;
  h.deleteByIds.mockClear();
  h.reconcileRuns.length = 0;
  runXmlTvNow.mockClear();
});

afterAll(async () => {
  await DBAccess.instance.closeConnection(`${dir.path}/db.db`);
  await dir.cleanup();
});

let nextNumber = 700;

function addMediaSource(): string {
  const uuid = v4();
  h.sqlite
    .prepare(
      `INSERT INTO media_source (uuid, access_token, "index", name, type, uri)
       VALUES (?, '', 0, ?, 'plex', 'http://plex')`,
    )
    .run(uuid, uuid);
  return uuid;
}

function addShow(title: string): string {
  const uuid = v4();
  h.sqlite
    .prepare(
      `INSERT INTO program_grouping (uuid, title, type) VALUES (?, ?, 'show')`,
    )
    .run(uuid, title);
  return uuid;
}

function addEpisode(opts: {
  mediaSourceId: string;
  showId: string;
  season: number | null;
  episode: number | null;
  state: 'ok' | 'missing';
  ids?: Record<string, string>;
  duration?: number;
}): string {
  const uuid = v4();
  h.sqlite
    .prepare(
      `INSERT INTO program (uuid, duration, external_key, external_source_id, source_type,
         title, type, state, season_number, episode, tv_show_uuid, media_source_id)
       VALUES (?, ?, ?, 'plex', 'plex', ?, 'episode', ?, ?, ?, ?, ?)`,
    )
    .run(
      uuid,
      opts.duration ?? 2_820_000,
      uuid,
      `Episode ${opts.season}x${opts.episode}`,
      opts.state,
      opts.season,
      opts.episode,
      opts.showId,
      opts.mediaSourceId,
    );
  for (const [source, key] of Object.entries(opts.ids ?? {})) {
    h.sqlite
      .prepare(
        `INSERT INTO program_external_id (uuid, external_key, program_uuid, source_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(v4(), key, uuid, source);
  }
  return uuid;
}

async function addChannel(): Promise<string> {
  const channel: SaveableChannel = {
    id: v4(),
    name: `Repair test ${nextNumber}`,
    number: nextNumber++,
    startTime: Date.now() - 86_400_000,
    duration: 0,
    offline: { mode: 'pic' },
    guideMinimumDuration: 30_000,
    icon: { path: '', width: 100, duration: 0, position: 'bottom-right' },
    disableFillerOverlay: false,
    groupTitle: '',
    stealth: false,
    streamMode: 'hls',
    transcodeConfigId: h.transcodeConfigId,
    subtitlesEnabled: false,
  };
  return (await h.channelDb.saveChannel(channel)).channel.uuid;
}

function count(table: string, column: string, id: string): number {
  return (
    h.sqlite
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(id) as { n: number }
  ).n;
}

describe('TrashRepairService', () => {
  test('merges an exact match: every use moves, the schedule stays, the old record goes with a receipt', async () => {
    const source = addMediaSource();
    const show = addShow('Mad Men');
    const ids = { 'plex-guid': `plex://episode/${v4()}`, tvdb: v4() };
    const old = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 3,
      state: 'missing',
      ids,
    });
    const healthy = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 3,
      state: 'ok',
      ids,
      duration: 2_650_000,
    });
    const other = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 4,
      state: 'ok',
    });

    const channel = await addChannel();
    await h.lineups.saveLineup(channel, {
      items: [
        { type: 'content', id: old, durationMs: 2_820_000 },
        { type: 'offline', durationMs: 60_000 },
        { type: 'content', id: other, durationMs: 2_820_000 },
      ],
      scheduleSeed: [4, 2],
    });
    h.sqlite
      .prepare(
        'INSERT INTO channel_programs (channel_uuid, program_uuid) VALUES (?, ?)',
      )
      .run(channel, old);
    const customShow = v4();
    h.sqlite
      .prepare('INSERT INTO custom_show (uuid, name) VALUES (?, ?)')
      .run(customShow, 'Comfort');
    h.sqlite
      .prepare(
        'INSERT INTO custom_show_content (content_uuid, custom_show_uuid, "index") VALUES (?, ?, 0)',
      )
      .run(old, customShow);
    const filler = v4();
    h.sqlite
      .prepare('INSERT INTO filler_show (uuid, name) VALUES (?, ?)')
      .run(filler, 'Pool');
    h.sqlite
      .prepare(
        'INSERT INTO filler_show_content (filler_show_uuid, "index", program_uuid) VALUES (?, 0, ?)',
      )
      .run(filler, old);
    h.sqlite
      .prepare(
        'INSERT INTO program_play_history (uuid, program_uuid, channel_uuid, played_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(v4(), old, channel, Date.now(), Date.now());

    const plan = await h.service.plan();
    expect(plan.exact.map((m) => [m.old.id, m.healthy.id])).toEqual([
      [old, healthy],
    ]);
    expect(plan.exact[0]!.matchedOn).toEqual(['plex-guid', 'tvdb']);
    expect(plan.exact[0]!.uses).toEqual({
      channels: 1,
      customShows: 1,
      fillerLists: 1,
      playHistory: 1,
    });

    const result = await h.service.repair({ dryRun: false });

    expect(result.merged).toEqual([{ oldId: old, healthyId: healthy }]);
    const lineup = await h.lineups.loadLineup(channel, true);
    expect(lineup.items[0]).toEqual({
      type: 'content',
      id: healthy,
      durationMs: 2_820_000,
    });
    expect(lineup.items[2]).toEqual({
      type: 'content',
      id: other,
      durationMs: 2_820_000,
    });
    expect(lineup.scheduleSeed).toEqual([4, 2]);
    for (const [table, column] of Object.entries(UsageTables)) {
      expect(count(table, column, old)).toBe(0);
    }
    expect(count('channel_programs', 'program_uuid', healthy)).toBe(1);
    expect(count('custom_show_content', 'content_uuid', healthy)).toBe(1);
    expect(count('filler_show_content', 'program_uuid', healthy)).toBe(1);
    expect(count('program_play_history', 'program_uuid', healthy)).toBe(1);
    expect(count('program', 'uuid', old)).toBe(0);
    expect(count('program_external_id', 'program_uuid', old)).toBe(0);
    expect(count('program', 'uuid', healthy)).toBe(1);
    expect(h.deleteByIds).toHaveBeenCalledWith([old]);
    // The new copy is 2.8 minutes shorter; durations are reconciled.
    expect(h.reconcileRuns).toEqual([{ type: 'program', programId: healthy }]);
    // A lineup changed, so the guide is rebuilt.
    expect(runXmlTvNow).toHaveBeenCalledExactlyOnceWith(true);

    const receipt = JSON.parse(
      await fs.readFile(result.receipts[0]!, 'utf-8'),
    ) as {
      merges: {
        oldId: string;
        program: { uuid: string };
        lineupPositions: Record<string, number[]>;
        usage: Record<string, unknown[]>;
      }[];
    };
    expect(receipt.merges[0]!.program.uuid).toBe(old);
    expect(receipt.merges[0]!.lineupPositions).toEqual({ [channel]: [0] });
    expect(receipt.merges[0]!.usage.program_play_history).toHaveLength(1);

    // A second run has nothing left to do.
    const again = await h.service.repair({ dryRun: false });
    expect(again.merged).toEqual([]);
    expect(again.exact).toEqual([]);
  });

  test('a dry run changes nothing', async () => {
    const source = addMediaSource();
    const show = addShow('Mad Men');
    const ids = { imdb: `tt${v4()}` };
    const old = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 2,
      episode: 5,
      state: 'missing',
      ids,
    });
    addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 2,
      episode: 5,
      state: 'ok',
      ids,
    });

    const result = await h.service.repair({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.merged).toEqual([]);
    expect(result.exact.map((m) => m.old.id)).toEqual([old]);
    expect(count('program', 'uuid', old)).toBe(1);
    expect(h.deleteByIds).not.toHaveBeenCalled();
  });

  test('asks "Same show, new file?" instead of merging when it is not sure', async () => {
    const plex = addMediaSource();
    const jellyfin = addMediaSource();
    const show = addShow('Sure Thing');
    const shared = (k: string) => ({ tvdb: `${k}-${v4()}` });

    const twoCopiesIds = shared('two');
    const twoCopies = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 1,
      state: 'missing',
      ids: twoCopiesIds,
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 1,
      state: 'ok',
      ids: twoCopiesIds,
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 1,
      state: 'ok',
      ids: twoCopiesIds,
    });

    const elsewhereIds = shared('elsewhere');
    const elsewhere = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 2,
      state: 'missing',
      ids: elsewhereIds,
    });
    addEpisode({
      mediaSourceId: jellyfin,
      showId: show,
      season: 1,
      episode: 2,
      state: 'ok',
      ids: elsewhereIds,
    });

    const renumberedIds = shared('renumbered');
    const renumbered = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 3,
      state: 'missing',
      ids: renumberedIds,
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 9,
      state: 'ok',
      ids: renumberedIds,
    });

    // A missing number must not hide a conflict in the other one.
    const otherSeasonIds = shared('other-season');
    const otherSeason = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 5,
      state: 'missing',
      ids: otherSeasonIds,
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 2,
      episode: null,
      state: 'ok',
      ids: otherSeasonIds,
    });

    const otherEpisodeIds = shared('other-episode');
    const otherEpisode = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: null,
      episode: 6,
      state: 'missing',
      ids: otherEpisodeIds,
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 7,
      state: 'ok',
      ids: otherEpisodeIds,
    });

    const lookalike = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 4,
      state: 'missing',
      ids: shared('look-old'),
    });
    addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 1,
      episode: 4,
      state: 'ok',
      ids: shared('look-new'),
    });

    const gone = addEpisode({
      mediaSourceId: plex,
      showId: show,
      season: 7,
      episode: 7,
      state: 'missing',
      ids: shared('gone'),
    });

    const result = await h.service.repair({ dryRun: false });

    expect(result.merged).toEqual([]);
    const reasons = Object.fromEntries(
      result.questions.map((q) => [q.old.id, q.reason]),
    );
    expect(reasons).toEqual({
      [twoCopies]: 'several_copies',
      [elsewhere]: 'other_media_source',
      [renumbered]: 'numbers_differ',
      [otherSeason]: 'numbers_differ',
      [otherEpisode]: 'numbers_differ',
      [lookalike]: 'details_match_only',
    });
    expect(
      result.questions.every((q) => q.question === 'Same show, new file?'),
    ).toBe(true);
    expect(result.gone).toBe(1);
    for (const id of [
      twoCopies,
      elsewhere,
      renumbered,
      otherSeason,
      otherEpisode,
      lookalike,
      gone,
    ]) {
      expect(count('program', 'uuid', id)).toBe(1);
    }
  });

  test('a confirmed question is merged; a dismissed one stays hidden until a new copy turns up', async () => {
    const source = addMediaSource();
    const show = addShow('Lookalikes');
    const confirmOld = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 3,
      episode: 1,
      state: 'missing',
    });
    const confirmNew = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 3,
      episode: 1,
      state: 'ok',
    });
    const dismissOld = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 3,
      episode: 2,
      state: 'missing',
    });
    addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 3,
      episode: 2,
      state: 'ok',
    });

    // Only a candidate the plan actually offers is accepted.
    const wrong = await h.service.repair({
      dryRun: false,
      confirm: [{ oldId: confirmOld, healthyId: v4() }],
    });
    expect(wrong.merged).toEqual([]);

    const confirmed = await h.service.repair({
      dryRun: false,
      confirm: [{ oldId: confirmOld, healthyId: confirmNew }],
    });
    expect(confirmed.merged).toEqual([
      { oldId: confirmOld, healthyId: confirmNew },
    ]);
    expect(count('program', 'uuid', confirmOld)).toBe(0);

    const afterDismiss = await h.service.dismiss([dismissOld]);
    expect(afterDismiss.questions.map((q) => q.old.id)).not.toContain(
      dismissOld,
    );
    expect(afterDismiss.dismissed).toBe(1);

    addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 3,
      episode: 2,
      state: 'ok',
    });
    const reasked = await h.service.plan();
    expect(reasked.questions.map((q) => q.old.id)).toContain(dismissOld);
  });

  test('does nothing automatically when the setting is off', async () => {
    h.settings.repairReaddedItems = false;
    const source = addMediaSource();
    const show = addShow('Off');
    const ids = { tmdb: v4() };
    const old = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 1,
      state: 'missing',
      ids,
    });
    addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 1,
      state: 'ok',
      ids,
    });

    await h.service.runIfEnabled('test');

    expect(count('program', 'uuid', old)).toBe(1);
  });

  test('startup repairs only when that option is also on', async () => {
    const source = addMediaSource();
    const show = addShow('Startup');
    const ids = { tvdb: v4() };
    const old = addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 1,
      state: 'missing',
      ids,
    });
    addEpisode({
      mediaSourceId: source,
      showId: show,
      season: 1,
      episode: 1,
      state: 'ok',
      ids,
    });

    // After scans: on. At startup: off by default.
    await h.service.runIfEnabled('startup');
    expect(count('program', 'uuid', old)).toBe(1);

    h.settings.repairReaddedItemsOnStartup = true;
    await h.service.runIfEnabled('startup');
    expect(count('program', 'uuid', old)).toBe(0);
  });

  test('a failed repair stops Empty Trash, but not a scan', async () => {
    const repair = vi
      .spyOn(h.service, 'repair')
      .mockRejectedValue(new Error('receipt folder is read-only'));
    try {
      await expect(h.service.runIfEnabled('empty trash')).rejects.toThrow(
        'receipt folder is read-only',
      );
      await expect(
        h.service.runIfEnabled('library scan'),
      ).resolves.toBeUndefined();
    } finally {
      repair.mockRestore();
    }
  });

  test('a large repair runs in batches, each with its own receipt', async () => {
    const source = addMediaSource();
    const show = addShow('Big Trash');
    const olds: string[] = [];
    for (let episode = 1; episode <= 260; episode++) {
      const ids = { tvdb: v4() };
      olds.push(
        addEpisode({
          mediaSourceId: source,
          showId: show,
          season: 1,
          episode,
          state: 'missing',
          ids,
        }),
      );
      addEpisode({
        mediaSourceId: source,
        showId: show,
        season: 1,
        episode,
        state: 'ok',
        ids,
      });
    }

    const result = await h.service.repair({ dryRun: false });

    expect(result.merged).toHaveLength(260);
    expect(result.receipts).toHaveLength(2);
    const sizes = await Promise.all(
      result.receipts.map(
        async (r) =>
          (JSON.parse(await fs.readFile(r, 'utf-8')) as { merges: unknown[] })
            .merges.length,
      ),
    );
    expect(sizes).toEqual([250, 10]);
    expect(olds.filter((id) => count('program', 'uuid', id) > 0)).toEqual([]);
  });

  test('every table pointing at a program is either moved or removed on purpose', () => {
    const tables = (
      h.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    const referencing: Record<string, string> = {};
    for (const table of tables) {
      for (const fk of h.sqlite
        .prepare(`PRAGMA foreign_key_list("${table}")`)
        .all() as { table: string; from: string }[]) {
        if (fk.table === 'program') {
          referencing[table] = fk.from;
        }
      }
    }
    // A new table here (favorites, watch status) must be added to UsageTables
    // if it describes how the program is used, so a repair carries it over.
    expect(referencing).toEqual({ ...UsageTables, ...FileTables });
  });
});
