import type {
  CreateFillerListRequest,
  SmartFillerSyncResult,
  UpdateFillerListRequest,
} from '@tunarr/types/api';
import { Mutex } from 'async-mutex';
import { inject, injectable } from 'inversify';
import { isEqual, isError, sortBy, uniq } from 'lodash-es';
import { FillerDB } from '../db/FillerListDB.ts';
import type { FillerShowWithContent } from '../db/interfaces/IFillerListDB.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { SmartCollectionsDB } from '../db/SmartCollectionsDB.ts';
import { GenericNotFoundError, SmartFillerSyncError } from '../types/errors.ts';
import { KEYS } from '../types/inject.ts';
import type { Nilable } from '../types/util.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { isTerminalProgramDocument } from '../util/search.ts';
import { MeilisearchService } from './MeilisearchService.ts';
import { hasSchedulableDuration } from './scheduling/slotSchedulerUtil.ts';

type SmartFillerContent = Omit<
  SmartFillerSyncResult,
  'fillerListId' | 'smartCollectionId' | 'programCount'
> & { programIds: string[] };

// Indexing after a scan normally settles within minutes. Past this, the
// post-scan sync is skipped and every list keeps its content until the next
// scan, rather than holding a task slot indefinitely.
const INDEX_WAIT_MS = 30 * 60 * 1000;

// Filler lists whose content comes from a smart collection's results. The
// content is copied into the list, so everything that reads filler lists
// (pods, slot filler, channel flex filler, refresh) works on it unchanged.
// A sync never empties a list: when the collection can't supply playable
// clips, the list keeps what it had.
@injectable()
export class SmartFillerListService {
  // Syncs run one at a time. Scans that finish together each queue a sync,
  // and a slow search must not land after a newer one.
  private static syncLock = new Mutex();

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(FillerDB) private fillerDB: FillerDB,
    @inject(SmartCollectionsDB) private smartCollectionsDB: SmartCollectionsDB,
    @inject(KEYS.ProgramDB) private programDB: ProgramDB,
    @inject(MeilisearchService) private searchService: MeilisearchService,
  ) {}

  async create(request: CreateFillerListRequest): Promise<string> {
    const smartCollectionId = request.smartCollectionId;
    if (!smartCollectionId) {
      return this.fillerDB.createFiller(request);
    }
    return SmartFillerListService.syncLock.runExclusive(async () => {
      const content = await this.resolve(smartCollectionId);
      return this.fillerDB.createFiller(request, content.programIds);
    });
  }

  async update(
    id: string,
    request: UpdateFillerListRequest,
  ): Promise<Nilable<FillerShowWithContent>> {
    return SmartFillerListService.syncLock.runExclusive(async () => {
      const current = await this.fillerDB.getFiller(id);
      if (!current) {
        return null;
      }
      const linkedAfter =
        request.smartCollectionId === undefined
          ? current.smartCollectionId
          : request.smartCollectionId;
      if (request.programs && linkedAfter) {
        // The list editor always sends the programs it loaded, so a rename
        // of a linked list arrives with its current content.
        const unchanged = isEqual(
          sortBy(uniq(request.programs.map((program) => program.id))),
          sortBy(current.fillerContent.map((program) => program.uuid)),
        );
        if (!unchanged) {
          throw new SmartFillerSyncError(
            'This filler list takes its programs from a smart collection. Unlink it with smartCollectionId: null to edit programs by hand.',
          );
        }
        request = { ...request, programs: undefined };
      }
      const linkedProgramIds = request.smartCollectionId
        ? (await this.resolve(request.smartCollectionId)).programIds
        : undefined;
      return this.fillerDB.saveFiller(id, request, linkedProgramIds);
    });
  }

  async sync(id: string): Promise<SmartFillerSyncResult> {
    return SmartFillerListService.syncLock.runExclusive(() =>
      this.syncList(id),
    );
  }

  // Runs after library scans. Waits for search indexing to catch up so newly
  // scanned clips are found, and carries on past a list that can't sync.
  async syncAll(): Promise<void> {
    const linked = await this.fillerDB.getLinkedFillers();
    if (linked.length === 0) {
      return;
    }
    try {
      await this.searchService.waitForPendingIndexTasks(INDEX_WAIT_MS);
    } catch (e) {
      this.logger.warn(
        e,
        'Search indexing did not finish; %d linked filler lists kept their content',
        linked.length,
      );
      return;
    }
    await SmartFillerListService.syncLock.runExclusive(async () => {
      for (const filler of linked) {
        try {
          const result = await this.syncList(filler.uuid);
          this.logger.debug(
            'Synced filler list %s (%s): %d clips',
            filler.name,
            filler.uuid,
            result.programCount,
          );
        } catch (e) {
          this.logger.warn(
            e,
            'Filler list %s (%s) kept its previous content',
            filler.name,
            filler.uuid,
          );
        }
      }
    });
  }

  private async syncList(id: string): Promise<SmartFillerSyncResult> {
    const filler = await this.fillerDB.getFiller(id);
    if (!filler) {
      throw new GenericNotFoundError(id, 'filler list');
    }
    const smartCollectionId = filler.smartCollectionId;
    if (!smartCollectionId) {
      throw new SmartFillerSyncError(
        `Filler list ${id} is not linked to a smart collection`,
      );
    }
    const { programIds, ...counts } = await this.resolve(smartCollectionId);
    if (
      !this.fillerDB.replaceSyncedContent(id, smartCollectionId, programIds)
    ) {
      throw new SmartFillerSyncError(
        `Filler list ${id} was relinked or unlinked during the sync, so it was left as it was`,
      );
    }
    return {
      fillerListId: id,
      smartCollectionId,
      programCount: programIds.length,
      ...counts,
    };
  }

  // The collection's current results as playable whole clips, in search
  // order. Rejects empty results and indexing detected before or after lookup.
  private async resolve(
    smartCollectionId: string,
  ): Promise<SmartFillerContent> {
    let docs: Awaited<
      ReturnType<SmartCollectionsDB['materializeSmartCollection']>
    >;
    try {
      // While the index is rebuilding, a search returns only what has been
      // indexed so far.
      if (await this.searchService.hasPendingIndexTasks()) {
        throw new Error('the search index is still updating; try again later');
      }
      docs = await this.smartCollectionsDB.materializeSmartCollection(
        smartCollectionId,
        true,
        true,
      );
    } catch (e) {
      throw new SmartFillerSyncError(
        `Smart collection ${smartCollectionId} could not be searched: ${isError(e) ? e.message : String(e)}`,
        { cause: e },
      );
    }

    // A filler list holds whole clips. A matched show, season, artist or
    // album is left out rather than expanded into everything it contains.
    const clips = docs.filter(isTerminalProgramDocument);
    const clipIds = uniq(clips.map((doc) => doc.id));
    const programs = await this.programDB.getProgramsByIds(clipIds);
    const playable = new Set(
      programs
        .filter(
          (program) =>
            program.state === 'ok' && hasSchedulableDuration(program.duration),
        )
        .map((program) => program.uuid),
    );
    const programIds = clipIds.filter((id) => playable.has(id));
    if (programIds.length === 0) {
      throw new SmartFillerSyncError(
        `Smart collection ${smartCollectionId} has no playable clips`,
      );
    }
    if (await this.searchService.hasPendingIndexTasks()) {
      throw new SmartFillerSyncError(
        'The search index is still updating; try again later',
      );
    }
    return {
      programIds,
      skippedGroupings: docs.length - clips.length,
      skippedUnplayable: clipIds.length - programIds.length,
    };
  }
}
