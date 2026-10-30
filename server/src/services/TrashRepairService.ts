import type { LineupRepository } from '@/db/channel/LineupRepository.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ProgramStateRepository } from '@/db/program/ProgramStateRepository.js';
import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { globalOptions } from '@/globals.js';
import { ScheduleValidationError } from '@/types/errors.js';
import { autoFactoryKey, KEYS } from '@/types/inject.js';
import { fileExists, writeFileAtomic } from '@/util/fsUtil.js';
import { wait } from '@/util/index.js';
import { InjectLogger } from '@/util/inject.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type {
  TrashRepairItem,
  TrashRepairMatch,
  TrashRepairPlan,
  TrashRepairQuestion,
  TrashRepairRequest,
  TrashRepairResult,
  TrashRepairUses,
} from '@tunarr/types/api';
import { Mutex } from 'async-mutex';
import dayjs from 'dayjs';
import { sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { chunk, groupBy, isEqual, sortBy, uniq, uniqBy } from 'lodash-es';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconcileProgramDurationsTask } from '../tasks/ReconcileProgramDurationsTask.ts';
import { MeilisearchService } from './MeilisearchService.ts';

// Repairs items a media server re-added under a new ID (#67).
//
// When Plex rebuilds a library or swaps in an upgraded file, the item comes
// back as a new program and the old record lands in the Trash while
// channels, custom shows and filler lists still use it. Emptying the Trash
// would turn those spots into flex. A repair merges the old record into its
// healthy copy instead: everything about how the program is used moves to the
// copy, and only facts about the old file go away with the old record.

// Tables pointing at program.uuid that describe how a program is used. These
// move to the healthy copy. Every table referencing program.uuid must be
// listed here or in FileTables; a test enforces it, so a new kind of user data
// (favorites, watch status) can't be dropped by accident.
export const UsageTables = {
  channel_programs: 'program_uuid',
  channel_fallback: 'program_uuid',
  custom_show_content: 'content_uuid',
  filler_show_content: 'program_uuid',
  program_play_history: 'program_uuid',
  external_collection_programs: 'program_id',
} as const;

// Tables pointing at program.uuid that describe the old file itself. The
// healthy copy has its own; these rows are removed with the old record (they
// cascade) and kept in the receipt.
export const FileTables = {
  artwork: 'program_id',
  credit: 'program_id',
  genre_entity: 'program_id',
  program_external_id: 'program_uuid',
  program_subtitles: 'program_id',
  program_version: 'program_id',
  studio_entity: 'program_id',
  tag_relations: 'program_id',
} as const;

// Identifiers that stay the same when a media server re-adds an item.
const StableIdSources = ['plex-guid', 'imdb', 'tmdb', 'tvdb'] as const;

const RepairDirectory = 'trash-repairs';
// Merges per transaction, receipt file and pause, as in Empty Trash.
const RepairBatchSize = 250;
const DismissedFile = 'dismissed.json';

type ProgramRow = {
  id: string;
  type: string;
  title: string;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  mediaSourceId: string | null;
};

type Candidate = ProgramRow & { matchedOn: string[] };

export type TrashUse = {
  // Programs in the Trash when it was read.
  trashed: number;
  inUse: TrashedInUse[];
};

export type TrashedInUse = {
  item: TrashRepairItem;
  channelIds: string[];
  customShowIds: string[];
  fillerListIds: string[];
  playHistory: number;
};

type Dismissed = Record<
  string,
  { candidateIds: string[]; dismissedAt: number }
>;

@injectable()
export class TrashRepairService {
  @InjectLogger() declare private readonly logger: Logger;

  private static readonly mutex = new Mutex();

  constructor(
    @inject(KEYS.DrizzleDB) private drizzleDB: DrizzleDBAccess,
    @inject(KEYS.LineupRepository) private lineups: LineupRepository,
    @inject(KEYS.ProgramStateRepository)
    private stateRepo: ProgramStateRepository,
    @inject(MeilisearchService) private search: MeilisearchService,
    @inject(KEYS.SettingsDB) private settings: ISettingsDB,
    // By name: importing the task class here closes an import cycle.
    @inject(autoFactoryKey('ReconcileProgramDurationsTask'))
    private reconcileTaskFactory: () => ReconcileProgramDurationsTask,
  ) {}

  /**
   * Repairs exact matches when the settings allow it. A failure is only
   * logged, except before Empty Trash: deleting after a failed repair would
   * blank programming that a healthy copy could have kept.
   */
  async runIfEnabled(
    trigger: 'startup' | 'library scan' | 'empty trash',
  ): Promise<void> {
    const settings = this.settings.globalMediaSourceSettings();
    if (
      !settings.repairReaddedItems ||
      (trigger === 'startup' && !settings.repairReaddedItemsOnStartup)
    ) {
      return;
    }
    try {
      const result = await this.repair({ dryRun: false });
      if (result.merged.length > 0 || result.questions.length > 0) {
        this.logger.info(
          'Trash repair (%s): merged %d re-added item(s) into their healthy copies; %d need confirmation',
          trigger,
          result.merged.length,
          result.questions.length,
        );
      }
    } catch (e) {
      this.logger.error(e, 'Trash repair (%s) failed', trigger);
      if (trigger === 'empty trash') {
        throw e;
      }
    }
  }

  plan(): Promise<TrashRepairPlan> {
    return TrashRepairService.mutex.runExclusive(() => this.#plan());
  }

  /**
   * Trashed programs that channels, custom shows or filler lists still use,
   * and where, with how many programs the Trash held at that moment. Emptying
   * the Trash turns each of these spots into flex, so "only unused" leaves
   * them alone. Channel use is read from the lineups themselves, since those
   * are what Empty Trash rewrites.
   */
  inUse(): Promise<TrashUse> {
    return TrashRepairService.mutex.runExclusive(async () => {
      const trashed = this.#trashed();
      return { trashed: trashed.length, inUse: await this.#inUse(trashed) };
    });
  }

  /**
   * The repair plan and where trashed programs are used, both worked out
   * from one read of the Trash while repairs are held off, so every count
   * describes the same set of programs.
   */
  impactSnapshot(): Promise<TrashUse & { plan: TrashRepairPlan }> {
    return TrashRepairService.mutex.runExclusive(async () => {
      const trashed = this.#trashed();
      return {
        trashed: trashed.length,
        inUse: await this.#inUse(trashed),
        plan: await this.#plan(trashed),
      };
    });
  }

  repair(request: TrashRepairRequest): Promise<TrashRepairResult> {
    return TrashRepairService.mutex.runExclusive(async () => {
      const plan = await this.#plan();
      if (request.dryRun) {
        return { ...plan, dryRun: true, merged: [], receipts: [] };
      }

      const pairs = plan.exact.map((m) => ({
        oldId: m.old.id,
        healthyId: m.healthy.id,
      }));
      // A confirmation must answer a question this plan actually asks.
      for (const answer of request.confirm ?? []) {
        const question = plan.questions.find((q) => q.old.id === answer.oldId);
        if (
          question?.candidates.some((c) => c.id === answer.healthyId) &&
          !pairs.some((p) => p.oldId === answer.oldId)
        ) {
          pairs.push(answer);
        }
      }

      const merged = await this.#merge(pairs);
      const after = await this.#plan();
      return {
        ...after,
        dryRun: false,
        merged: merged.pairs,
        receipts: merged.receipts,
      };
    });
  }

  /** Hides questions until a different healthy copy turns up. */
  dismiss(oldIds: string[]): Promise<TrashRepairPlan> {
    return TrashRepairService.mutex.runExclusive(async () => {
      const plan = await this.#plan();
      const dismissed = await this.#readDismissed();
      for (const oldId of oldIds) {
        const question = plan.questions.find((q) => q.old.id === oldId);
        if (question) {
          dismissed[oldId] = {
            candidateIds: sortBy(question.candidates.map((c) => c.id)),
            dismissedAt: Date.now(),
          };
        }
      }
      await this.#writeDismissed(dismissed);
      return this.#plan();
    });
  }

  #trashed(): ProgramRow[] {
    return this.drizzleDB.all<ProgramRow>(sql`
      SELECT p.uuid AS id, p.type, p.title, g.title AS showTitle,
             p.season_number AS seasonNumber, p.episode AS episodeNumber,
             p.year, p.media_source_id AS mediaSourceId
      FROM program p
      LEFT JOIN program_grouping g ON g.uuid = p.tv_show_uuid
      WHERE p.state <> 'ok'`);
  }

  // Classifies exactly the given trashed programs, so a caller holding one
  // read of the Trash gets a plan about that same set.
  async #plan(trashed = this.#trashed()): Promise<TrashRepairPlan> {
    if (trashed.length === 0) {
      return { exact: [], questions: [], gone: 0, dismissed: 0 };
    }

    const stableRows = this.drizzleDB.all<
      ProgramRow & {
        oldId: string;
        source: string;
      }
    >(sql`
      SELECT o.uuid AS oldId, oe.source_type AS source,
             n.uuid AS id, n.type, n.title, g.title AS showTitle,
             n.season_number AS seasonNumber, n.episode AS episodeNumber,
             n.year, n.media_source_id AS mediaSourceId
      FROM program o
      JOIN program_external_id oe ON oe.program_uuid = o.uuid
        AND oe.source_type IN (${sql.join(
          StableIdSources.map((s) => sql`${s}`),
          sql`, `,
        )})
      JOIN program_external_id ne ON ne.source_type = oe.source_type
        AND ne.external_key = oe.external_key AND ne.program_uuid <> o.uuid
      JOIN program n ON n.uuid = ne.program_uuid
        AND n.state = 'ok' AND n.type = o.type
      LEFT JOIN program_grouping g ON g.uuid = n.tv_show_uuid
      WHERE o.state <> 'ok'`);
    const stableByOld = groupBy(stableRows, (r) => r.oldId);
    const dismissed = await this.#readDismissed();

    const exact: TrashRepairMatch[] = [];
    const questions: TrashRepairQuestion[] = [];
    let gone = 0;
    let dismissedCount = 0;

    for (const old of trashed) {
      const candidates = toCandidates(stableByOld[old.id] ?? []);
      const sameSource = candidates.filter(
        (c) => c.mediaSourceId === old.mediaSourceId,
      );

      let question: Omit<TrashRepairQuestion, 'uses'> | undefined;
      if (sameSource.length === 1) {
        // The shared ID decides, not the season and episode numbers: a finale
        // re-filed as a special keeps its IDs but not its numbers.
        const [healthy] = sameSource;
        exact.push({
          old: toItem(old),
          healthy: toItem(healthy!),
          matchedOn: healthy!.matchedOn,
          uses: this.#uses(old.id),
        });
        continue;
      } else if (sameSource.length > 1) {
        question = ask(old, 'several_copies', sameSource);
      } else if (candidates.length > 0) {
        question = ask(old, 'other_media_source', candidates);
      } else {
        const lookalikes = this.#lookalikes(old);
        if (lookalikes.length > 0) {
          question = ask(old, 'details_match_only', lookalikes);
        }
      }

      if (!question) {
        gone++;
        continue;
      }
      const ids = sortBy(question.candidates.map((c) => c.id));
      if (isEqual(dismissed[old.id]?.candidateIds, ids)) {
        dismissedCount++;
        continue;
      }
      questions.push({ ...question, uses: this.#uses(old.id) });
    }

    return { exact, questions, gone, dismissed: dismissedCount };
  }

  async #inUse(captured: ProgramRow[]): Promise<TrashedInUse[]> {
    const trashed = new Map(captured.map((row) => [row.id, row]));
    if (trashed.size === 0) {
      return [];
    }

    const places = new Map<
      string,
      Record<'channel' | 'customShow' | 'fillerList', Set<string>>
    >();
    const add = (
      programId: string,
      kind: 'channel' | 'customShow' | 'fillerList',
      placeId: string,
    ) => {
      if (!trashed.has(programId)) {
        return;
      }
      let entry = places.get(programId);
      if (!entry) {
        entry = {
          channel: new Set(),
          customShow: new Set(),
          fillerList: new Set(),
        };
        places.set(programId, entry);
      }
      entry[kind].add(placeId);
    };

    for (const [channelId, { lineup }] of Object.entries(
      await this.lineups.loadAllLineups(),
    )) {
      for (const item of lineup.items) {
        if (item.type === 'content') {
          add(item.id, 'channel', channelId);
        }
      }
    }
    const rows = this.drizzleDB.all<{
      programId: string;
      kind: 'channel' | 'customShow' | 'fillerList';
      placeId: string;
    }>(sql`
      SELECT f.program_uuid AS programId, 'channel' AS kind,
             f.channel_uuid AS placeId
      FROM channel_fallback f
      JOIN program p ON p.uuid = f.program_uuid AND p.state <> 'ok'
      UNION ALL
      SELECT c.content_uuid, 'customShow', c.custom_show_uuid
      FROM custom_show_content c
      JOIN program p ON p.uuid = c.content_uuid AND p.state <> 'ok'
      UNION ALL
      SELECT s.program_uuid, 'fillerList', s.filler_show_uuid
      FROM filler_show_content s
      JOIN program p ON p.uuid = s.program_uuid AND p.state <> 'ok'`);
    for (const row of rows) {
      add(row.programId, row.kind, row.placeId);
    }

    return [...places.entries()].map(([programId, entry]) => ({
      item: toItem(trashed.get(programId)!),
      channelIds: [...entry.channel],
      customShowIds: [...entry.customShow],
      fillerListIds: [...entry.fillerList],
      playHistory:
        this.drizzleDB.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM program_play_history WHERE program_uuid = ${programId}`,
        )?.n ?? 0,
    }));
  }

  // Same show, season and episode, or same title and year. Never merged
  // without a confirmation.
  #lookalikes(old: ProgramRow): Candidate[] {
    const rows =
      old.type === 'episode'
        ? this.drizzleDB.all<ProgramRow>(sql`
            SELECT n.uuid AS id, n.type, n.title, g.title AS showTitle,
                   n.season_number AS seasonNumber, n.episode AS episodeNumber,
                   n.year, n.media_source_id AS mediaSourceId
            FROM program n
            JOIN program_grouping g ON g.uuid = n.tv_show_uuid
            WHERE n.state = 'ok' AND n.type = 'episode'
              AND g.title = ${old.showTitle}
              AND n.season_number IS ${old.seasonNumber}
              AND n.episode IS ${old.episodeNumber}`)
        : this.drizzleDB.all<ProgramRow>(sql`
            SELECT n.uuid AS id, n.type, n.title, NULL AS showTitle,
                   n.season_number AS seasonNumber, n.episode AS episodeNumber,
                   n.year, n.media_source_id AS mediaSourceId
            FROM program n
            WHERE n.state = 'ok' AND n.type = ${old.type}
              AND n.title = ${old.title} AND n.year IS ${old.year}`);
    return rows.map((r) => ({ ...r, matchedOn: [] }));
  }

  #uses(programId: string): TrashRepairUses {
    const count = (query: ReturnType<typeof sql>) =>
      this.drizzleDB.get<{ n: number }>(query)?.n ?? 0;
    return {
      channels: count(
        sql`SELECT count(DISTINCT channel_uuid) AS n FROM channel_programs WHERE program_uuid = ${programId}`,
      ),
      customShows: count(
        sql`SELECT count(DISTINCT custom_show_uuid) AS n FROM custom_show_content WHERE content_uuid = ${programId}`,
      ),
      fillerLists: count(
        sql`SELECT count(DISTINCT filler_show_uuid) AS n FROM filler_show_content WHERE program_uuid = ${programId}`,
      ),
      playHistory: count(
        sql`SELECT count(*) AS n FROM program_play_history WHERE program_uuid = ${programId}`,
      ),
    };
  }

  async #merge(pairs: { oldId: string; healthyId: string }[]): Promise<{
    pairs: { oldId: string; healthyId: string }[];
    receipts: string[];
  }> {
    // Re-check right before acting; the library may have changed.
    const valid: { oldId: string; healthyId: string }[] = [];
    for (const batch of chunk(pairs, RepairBatchSize)) {
      for (const pair of batch) {
        const rows = this.drizzleDB.all<{
          uuid: string;
          state: string;
          type: string;
        }>(
          sql`SELECT uuid, state, type FROM program WHERE uuid IN (${pair.oldId}, ${pair.healthyId})`,
        );
        const old = rows.find((r) => r.uuid === pair.oldId);
        const healthy = rows.find((r) => r.uuid === pair.healthyId);
        if (
          old !== undefined &&
          old.state !== 'ok' &&
          healthy?.state === 'ok' &&
          healthy.type === old.type
        ) {
          valid.push(pair);
        }
      }
      await wait(0);
    }
    if (valid.length === 0) {
      return { pairs: [], receipts: [] };
    }

    // The copy of everything about to change is written before anything
    // does, one file per batch so a large repair never builds one huge file.
    const replacement = new Map(valid.map((p) => [p.oldId, p.healthyId]));
    const allLineups = await this.lineups.loadAllLineups();
    const positions = new Map<string, Record<string, number[]>>();
    for (const [channelId, { lineup }] of Object.entries(allLineups)) {
      lineup.items.forEach((item, index) => {
        if (item.type === 'content' && replacement.has(item.id)) {
          const byChannel = positions.get(item.id) ?? {};
          (byChannel[channelId] ??= []).push(index);
          positions.set(item.id, byChannel);
        }
      });
    }
    const batches = chunk(valid, RepairBatchSize);
    const stamp = dayjs().format('YYYYMMDD-HHmmss-SSS');
    const receipts: string[] = [];
    for (const [index, batch] of batches.entries()) {
      receipts.push(
        await this.#writeReceipt(
          batch,
          positions,
          `repair-${stamp}${batches.length > 1 ? `-${index + 1}` : ''}.json`,
        ),
      );
      await wait(0);
    }

    // Lineups: swap the IDs in place, one save per channel. The schedule, its
    // seed and the clock are untouched; saveLineup also updates any offset
    // channels of the source.
    const changedChannels: string[] = [];
    for (const [channelId, { lineup }] of Object.entries(allLineups)) {
      let changed = false;
      const items = lineup.items.map((item) => {
        const healthyId =
          item.type === 'content' ? replacement.get(item.id) : undefined;
        if (healthyId) {
          changed = true;
          return { ...item, id: healthyId };
        }
        return item;
      });
      if (!changed) {
        continue;
      }
      try {
        await this.lineups.saveLineup(channelId, { items });
        changedChannels.push(channelId);
      } catch (e) {
        // A channel whose programming comes from another channel refuses the
        // write; it is updated when its source is saved.
        if (!(e instanceof ScheduleValidationError)) {
          throw e;
        }
        this.logger.debug(e, 'Trash repair left %s to its source', channelId);
      }
    }

    const reloaded = await this.lineups.loadAllLineups();
    const stillUsed = new Set(
      Object.values(reloaded).flatMap(({ lineup }) =>
        lineup.items.flatMap((i) => (i.type === 'content' ? [i.id] : [])),
      ),
    );

    // Everything else about how the program is used, then the old record
    // (its file facts cascade). Small batches with a pause between, as Empty
    // Trash does, so a large repair never stalls streams or the web UI.
    let kept = 0;
    for (const batch of batches) {
      this.drizzleDB.transaction((tx) => {
        for (const { oldId, healthyId } of batch) {
          for (const [table, column] of Object.entries(UsageTables)) {
            // OR IGNORE: the healthy copy may already be in the same channel,
            // filler list or collection; the old row is then simply dropped.
            tx.run(
              sql`UPDATE OR IGNORE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${healthyId} WHERE ${sql.identifier(column)} = ${oldId}`,
            );
            tx.run(
              sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${oldId}`,
            );
          }
        }
      });
      // Only a record nothing uses any more is removed.
      const removable = batch
        .map((p) => p.oldId)
        .filter((id) => !stillUsed.has(id));
      kept += batch.length - removable.length;
      await this.stateRepo.deleteProgramsByIds(removable);
      try {
        await this.search.deleteByIds(removable);
      } catch (e) {
        this.logger.warn(e, 'Trash repair could not remove search entries');
      }
      await wait(0);
    }
    if (kept > 0) {
      this.logger.warn(
        'Trash repair kept %d record(s) still used by a lineup',
        kept,
      );
    }

    // The healthy copies may be a different length.
    for (const healthyId of uniq(valid.map((p) => p.healthyId))) {
      const result = await this.reconcileTaskFactory().run({
        type: 'program',
        programId: healthyId,
      });
      if (result.isFailure()) {
        this.logger.warn(
          result.error,
          'Trash repair could not reconcile durations for %s',
          healthyId,
        );
      }
    }
    if (changedChannels.length > 0) {
      await this.#rebuildGuide();
    }

    return { pairs: valid, receipts };
  }

  async #writeReceipt(
    pairs: { oldId: string; healthyId: string }[],
    positions: Map<string, Record<string, number[]>>,
    fileName: string,
  ): Promise<string> {
    const rowsFor = (table: string, column: string, id: string) =>
      this.drizzleDB.all(
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${id}`,
      );
    const merges = pairs.map(({ oldId, healthyId }) => {
      const versionIds = this.drizzleDB
        .all<{
          uuid: string;
        }>(sql`SELECT uuid FROM program_version WHERE program_id = ${oldId}`)
        .map((v) => v.uuid);
      return {
        oldId,
        healthyId,
        program: this.drizzleDB.get(
          sql`SELECT * FROM program WHERE uuid = ${oldId}`,
        ),
        usage: Object.fromEntries(
          Object.entries(UsageTables).map(([t, c]) => [
            t,
            rowsFor(t, c, oldId),
          ]),
        ),
        file: {
          ...Object.fromEntries(
            Object.entries(FileTables).map(([t, c]) => [
              t,
              rowsFor(t, c, oldId),
            ]),
          ),
          ...Object.fromEntries(
            [
              'program_media_file',
              'program_media_stream',
              'program_chapter',
            ].map((t) => [
              t,
              versionIds.flatMap((v) => rowsFor(t, 'program_version_id', v)),
            ]),
          ),
        },
        lineupPositions: positions.get(oldId) ?? {},
      };
    });

    const directory = join(globalOptions().databaseDirectory, RepairDirectory);
    await fs.mkdir(directory, { recursive: true });
    const path = join(directory, fileName);
    await writeFileAtomic(path, JSON.stringify({ merges }, null, 1));
    return path;
  }

  async #readDismissed(): Promise<Dismissed> {
    const path = join(
      globalOptions().databaseDirectory,
      RepairDirectory,
      DismissedFile,
    );
    if (!(await fileExists(path))) {
      return {};
    }
    try {
      return JSON.parse(await fs.readFile(path, 'utf-8')) as Dismissed;
    } catch (e) {
      this.logger.warn(e, 'Unreadable %s; asking all questions again', path);
      return {};
    }
  }

  async #writeDismissed(dismissed: Dismissed) {
    const directory = join(globalOptions().databaseDirectory, RepairDirectory);
    await fs.mkdir(directory, { recursive: true });
    await writeFileAtomic(
      join(directory, DismissedFile),
      JSON.stringify(dismissed, null, 1),
    );
  }

  async #rebuildGuide() {
    // Loaded here: the scheduler module loads the DI container, which loads
    // this service.
    const { GlobalScheduler } = await import('./Scheduler.ts');
    const { UpdateXmlTvTask } = await import('../tasks/UpdateXmlTvTask.ts');
    try {
      GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
        .runNow(true)
        .catch((e) =>
          this.logger.warn(e, 'Failed to rebuild the guide after a repair'),
        );
    } catch (e) {
      // Not scheduled yet, for example during startup.
      this.logger.debug(e, 'Guide rebuild after a repair was not started');
    }
  }
}

function toCandidates(rows: (ProgramRow & { source: string })[]): Candidate[] {
  return Object.values(groupBy(rows, (r) => r.id)).map((same) => ({
    ...same[0]!,
    matchedOn: sortBy(uniq(same.map((r) => r.source))),
  }));
}

function toItem(row: ProgramRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    showTitle: row.showTitle,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    year: row.year,
  };
}

function ask(
  old: ProgramRow,
  reason: TrashRepairQuestion['reason'],
  candidates: Candidate[],
): Omit<TrashRepairQuestion, 'uses'> {
  return {
    old: toItem(old),
    question: 'Same show, new file?',
    reason,
    candidates: uniqBy(candidates, (c) => c.id).map((c) => ({
      ...toItem(c),
      matchedOn: c.matchedOn,
    })),
  };
}
