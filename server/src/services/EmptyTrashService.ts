import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ProgramStateRepository } from '@/db/program/ProgramStateRepository.js';
import type { ProgramGroupingType } from '@/db/schema/ProgramGrouping.js';
import { GlobalScheduler } from '@/services/Scheduler.js';
import { UpdateXmlTvTask } from '@/tasks/UpdateXmlTvTask.js';
import { KEYS } from '@/types/inject.js';
import type { Maybe } from '@/types/util.js';
import { wait } from '@/util/index.js';
import { InjectLogger } from '@/util/inject.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type { EmptyTrashImpact, EmptyTrashStatus } from '@tunarr/types/api';
import { Mutex } from 'async-mutex';
import { inject, injectable } from 'inversify';
import { EventService } from './EventService.ts';
import { MeilisearchService } from './MeilisearchService.ts';
import { TrashRepairService } from './TrashRepairService.ts';

/** Programs deleted per synchronous DELETE statement. */
export const EmptyTrashProgramBatchSize = 500;
/**
 * Groupings deleted per statement. Lower than the program batch because the
 * eligibility query runs two correlated NOT EXISTS per candidate row.
 */
const EmptyTrashGroupingBatchSize = 250;
/** Page size used when collecting every trashed ID for the lineup pass. */
const EmptyTrashIdPageSize = 10_000;
/**
 * `setTimeout(0)` rather than a microtask: only a real timer yields through the
 * poll phase, so pending socket I/O actually runs between batches.
 */
const EmptyTrashYieldMs = 0;

/**
 * Leaves before roots. A show only becomes deletable once its seasons are gone,
 * because `program_grouping.show_uuid` cascades.
 */
const GroupingDeletionOrder: readonly (readonly ProgramGroupingType[])[] = [
  ['season', 'album'],
  ['show', 'artist'],
];

const idleStatus = (): EmptyTrashStatus => ({
  state: 'idle',
  total: 0,
  deleted: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  onlyUnused: false,
  kept: 0,
});

/**
 * Drains the trash in small batches that yield to the event loop between each,
 * so a large empty-trash never stalls the HTTP server or an in-flight stream.
 *
 * The request is persisted, so an interrupted drain resumes after a restart.
 */
@injectable()
export class EmptyTrashService {
  @InjectLogger() declare private readonly logger: Logger;

  #mutex = new Mutex();
  #controller: Maybe<AbortController>;
  #cancelRequested = false;
  #status: EmptyTrashStatus = idleStatus();

  constructor(
    @inject(KEYS.ProgramStateRepository)
    private stateRepo: ProgramStateRepository,
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(MeilisearchService) private search: MeilisearchService,
    @inject(KEYS.SettingsDB) private settings: ISettingsDB,
    @inject(EventService) private events: EventService,
    @inject(TrashRepairService) private trashRepair: TrashRepairService,
  ) {}

  getStatus(): EmptyTrashStatus {
    return { ...this.#status };
  }

  /**
   * Records the request durably and starts a drain. A request made while one is
   * already running is an idempotent no-op, not a second drain.
   *
   * With onlyUnused, anything a channel, custom show or filler list still uses
   * stays in the Trash.
   */
  async request(
    options: { onlyUnused?: boolean } = {},
  ): Promise<EmptyTrashStatus> {
    if (this.#mutex.isLocked()) {
      return this.getStatus();
    }

    const onlyUnused = options.onlyUnused ?? false;
    await this.settings.markEmptyTrashRequested(Date.now(), onlyUnused);
    this.#kick(onlyUnused);
    return this.getStatus();
  }

  /**
   * What emptying the Trash would do right now: what gets merged into a
   * healthy copy first, what nothing uses, and what still plays somewhere and
   * would turn into flex. Changes nothing.
   */
  async impact(): Promise<EmptyTrashImpact> {
    const repairFirst =
      this.settings.globalMediaSourceSettings().repairReaddedItems;
    const plan = await this.trashRepair.plan();
    const inUse = await this.trashRepair.inUse();
    const total = await this.stateRepo.countMissingPrograms();

    const exact = new Set(plan.exact.map((m) => m.old.id));
    const questions = new Set(plan.questions.map((q) => q.old.id));
    const repairedFirst = repairFirst ? exact.size : 0;
    const used = inUse.filter((u) => !(repairFirst && exact.has(u.item.id)));
    const distinct = (ids: (u: (typeof used)[number]) => string[]) =>
      new Set(used.flatMap(ids)).size;

    return {
      total,
      repairedFirst,
      unused: total - repairedFirst - used.length,
      used: used.map((u) => ({
        ...u.item,
        uses: {
          channels: u.channelIds.length,
          customShows: u.customShowIds.length,
          fillerLists: u.fillerListIds.length,
          playHistory: u.playHistory,
        },
        repair: exact.has(u.item.id)
          ? 'exact'
          : questions.has(u.item.id)
            ? 'question'
            : null,
      })),
      affected: {
        channels: distinct((u) => u.channelIds),
        customShows: distinct((u) => u.customShowIds),
        fillerLists: distinct((u) => u.fillerListIds),
      },
    };
  }

  cancel(): EmptyTrashStatus {
    if (!this.#mutex.isLocked()) {
      return this.getStatus();
    }

    this.#cancelRequested = true;
    this.#controller?.abort();
    this.#status = { ...this.#status, state: 'cancelling' };
    return this.getStatus();
  }

  /**
   * Restarts a drain that was requested but never finished — a crash, a kill,
   * or a shutdown mid-run.
   */
  resumeIfRequested(): void {
    if (this.settings.pendingOperations.emptyTrashRequestedAt === null) {
      return;
    }

    if (this.#mutex.isLocked()) {
      return;
    }

    const { emptyTrashOnlyUnused } = this.settings.pendingOperations;
    this.logger.info(
      'Resuming interrupted empty trash operation%s',
      emptyTrashOnlyUnused ? ' (only unused items)' : '',
    );
    this.#kick(emptyTrashOnlyUnused);
  }

  #kick(onlyUnused: boolean): void {
    const controller = new AbortController();
    this.#controller = controller;
    this.#cancelRequested = false;

    void this.#mutex
      .runExclusive(() => this.#run(controller.signal, onlyUnused))
      .catch((e) => {
        this.logger.error(e, 'Empty trash drain failed');
      });
  }

  async #run(signal: AbortSignal, onlyUnused: boolean): Promise<void> {
    // Re-added items are merged into their healthy copies first, so emptying
    // the Trash only removes what is really gone. If that or the check for
    // what is still used fails, nothing is deleted and the request stays
    // pending.
    try {
      await this.trashRepair.runIfEnabled('empty trash');
    } catch (e) {
      this.#failBeforeDeleting(
        'Repairing re-added items failed',
        e,
        onlyUnused,
      );
      throw e;
    }
    let keep = new Set<string>();
    if (onlyUnused) {
      try {
        keep = new Set(
          (await this.trashRepair.inUse()).map(({ item }) => item.id),
        );
      } catch (e) {
        this.#failBeforeDeleting(
          'Checking what still uses the Trash failed',
          e,
          onlyUnused,
        );
        throw e;
      }
    }
    const total = (await this.stateRepo.countMissingPrograms()) - keep.size;
    this.#status = {
      state: 'running',
      total,
      deleted: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      onlyUnused,
      kept: keep.size,
    };
    this.#pushEvent('started');

    let completed = false;
    let failed = false;
    try {
      // PHASE 1 - rewrite affected lineups to flex. Must happen before any
      // delete: once the program rows are gone the dangling lineup content IDs
      // can no longer be identified.
      const ids = new Set<string>();
      for await (const page of this.stateRepo.allMissingProgramIds(
        EmptyTrashIdPageSize,
      )) {
        for (const id of page) {
          if (!keep.has(id)) {
            ids.add(id);
          }
        }
        await wait(EmptyTrashYieldMs);
        if (signal.aborted) {
          return;
        }
      }

      // With onlyUnused none of these are in a lineup, so this only guards
      // against one added since the check.
      const changedChannels =
        await this.channelDB.removeProgramsFromAllLineups(ids);
      this.logger.debug(
        'Empty trash rewrote %d channel lineup(s) for %d trashed program(s)',
        changedChannels,
        ids.size,
      );
      // "Only unused" deletes exactly what was checked; a full drain takes
      // whatever is in the Trash.
      const unused = onlyUnused ? [...ids] : undefined;
      ids.clear();

      // Lineups are final here even if the drain is cancelled later, so the
      // guide can be rebuilt now.
      if (changedChannels > 0) {
        this.#rebuildGuide();
      }

      // PHASE 2 - batched program deletes. Each DELETE cascades into the
      // program's child tables.
      let deleted = 0;
      while (!signal.aborted) {
        const batch = unused
          ? unused.splice(0, EmptyTrashProgramBatchSize)
          : await this.stateRepo.nextMissingProgramIds(
              EmptyTrashProgramBatchSize,
            );
        if (batch.length === 0) {
          break;
        }

        // "Only unused" works from a list made at the start, so a program a
        // scan has restored since then must not be deleted.
        const removed = await this.stateRepo.deleteMissingProgramsByIds(batch);
        deleted += removed.length;
        this.#status = {
          ...this.#status,
          deleted,
          total: Math.max(this.#status.total, deleted),
        };

        // Enqueue only. Awaiting task completion would serialize the drain
        // behind Meilisearch's indexing queue.
        void this.#deleteSearchDocuments(removed);
        await wait(EmptyTrashYieldMs);
      }

      // PHASE 3 - guarded, leaves-first grouping deletes.
      if (!signal.aborted) {
        for (const types of GroupingDeletionOrder) {
          for (;;) {
            if (signal.aborted) {
              break;
            }

            const groupingIds =
              await this.stateRepo.nextDeletableMissingGroupingIds(
                types,
                EmptyTrashGroupingBatchSize,
              );
            if (groupingIds.length === 0) {
              break;
            }

            await this.stateRepo.deleteGroupingsByIds(groupingIds);
            void this.#deleteSearchDocuments(groupingIds);
            await wait(EmptyTrashYieldMs);
          }
        }
      }

      completed = !signal.aborted;
    } catch (e) {
      failed = true;
      this.#status = {
        ...this.#status,
        state: 'failed',
        error: e instanceof Error ? e.message : String(e),
        finishedAt: Date.now(),
      };
      this.#pushEvent('failed', 'error');
      // The pending flag is deliberately left set so the drain resumes on the
      // next boot.
      throw e;
    } finally {
      if (!failed) {
        this.#status = {
          ...this.#status,
          state: 'idle',
          finishedAt: Date.now(),
        };

        if (completed) {
          await this.#compactDatabase();
        }

        // Clear on clean completion or explicit user cancel only. A crash or a
        // shutdown must leave the flag set - that is what makes resume work.
        if (completed || this.#cancelRequested) {
          await this.settings.clearEmptyTrashRequested();
        }

        this.#pushEvent(completed ? 'completed' : 'cancelled');
      }
    }
  }

  #failBeforeDeleting(what: string, e: unknown, onlyUnused: boolean): void {
    this.#status = {
      ...idleStatus(),
      state: 'failed',
      error: `${what}, so nothing was deleted: ${
        e instanceof Error ? e.message : String(e)
      }`,
      finishedAt: Date.now(),
      onlyUnused,
    };
    this.#pushEvent('failed', 'error');
  }

  async #deleteSearchDocuments(ids: string[]): Promise<void> {
    try {
      await this.search.deleteByIds(ids);
    } catch (e) {
      this.logger.warn(
        e,
        'Failed to remove %d emptied trash document(s) from the search index',
        ids.length,
      );
    }
  }

  /**
   * Rebuilds the guide and XMLTV so they stop listing trashed programs. Runs
   * in the background because a full guide build would stall the drain.
   */
  #rebuildGuide(): void {
    try {
      GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
        .runNow(true)
        .catch((e) => {
          this.logger.warn(
            e,
            'Failed to rebuild the guide after emptying trash',
          );
        });
    } catch (e) {
      // getScheduledJob throws when the job has not been scheduled yet.
      this.logger.warn(
        e,
        'Unable to start a guide rebuild after emptying trash',
      );
    }
  }

  /**
   * Reclaims the WAL grown by many small write transactions. Deliberately not
   * VACUUM, which is a long fully-blocking whole-file rewrite.
   */
  async #compactDatabase(): Promise<void> {
    try {
      await this.stateRepo.checkpointAndOptimize();
    } catch (e) {
      this.logger.warn(e, 'Failed to checkpoint database after emptying trash');
    }
  }

  #pushEvent(
    status: 'started' | 'completed' | 'cancelled' | 'failed',
    level: 'info' | 'error' = 'info',
  ): void {
    this.events.push({
      type: 'empty_trash',
      level,
      detail: {
        status,
        total: this.#status.total,
        deleted: this.#status.deleted,
      },
    });
  }
}
