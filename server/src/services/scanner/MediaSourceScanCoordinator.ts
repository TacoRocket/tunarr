import type { MediaSourceId } from '@tunarr/shared';
import { E_ALREADY_LOCKED, tryAcquire, type MutexInterface } from 'async-mutex';
import { inject, injectable } from 'inversify';
import PQueue from 'p-queue';
import { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import type { MediaSourceType } from '../../db/schema/base.ts';
import { ReconcileProgramDurationsTask } from '../../tasks/ReconcileProgramDurationsTask.ts';
import { RepairTrashedProgramsTask } from '../../tasks/RepairTrashedProgramsTask.ts';
import { SyncSmartFillerListsTask } from '../../tasks/SyncSmartFillerListsTask.ts';
import { autoFactoryKey, KEYS } from '../../types/inject.ts';
import type { PlexMovie, PlexEpisode } from '../../types/Media.ts';
import { Result } from '../../types/result.ts';
import type { Maybe } from '../../types/util.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { EntityMutex } from '../EntityMutex.ts';
import { GlobalScheduler } from '../Scheduler.ts';
import type { GenericExternalCollectionScanner } from './ExternalCollectionScanner.ts';
import type { GenericLocalMediaSourceScannerFactory } from './FileSystemScanner.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import type { GenericMediaSourceScannerFactory } from './MediaSourceScanner.ts';

@injectable()
export class MediaSourceScanCoordinator {
  private static queue: PQueue = new PQueue({ concurrency: 1 });
  private static signalById: Map<string, AbortController> = new Map();
  // A full scan may claim the next turn behind a notification. Removing the
  // entry reserves that turn, so duplicate full scans still get rejected.
  private static notificationOnlyLibraries = new Set<string>();

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(MediaSourceDB) private mediaSourceDB: MediaSourceDB,
    @inject(EntityMutex) private entityMutex: EntityMutex,
    @inject(KEYS.MediaSourceLibraryScanner)
    private scannerFactory: GenericMediaSourceScannerFactory,
    @inject(KEYS.LocalMediaSourceScanner)
    private localScannerFactory: GenericLocalMediaSourceScannerFactory,
    @inject(MediaSourceProgressService)
    private progressService: MediaSourceProgressService,
    @inject(KEYS.ExternalCollectionScannerFactory)
    private collectionScannerFactory: (
      sourceType: MediaSourceType,
    ) => Maybe<GenericExternalCollectionScanner>,
    @inject(autoFactoryKey(ReconcileProgramDurationsTask))
    private reconcileDurationsTaskFactory: () => ReconcileProgramDurationsTask,
    @inject(RepairTrashedProgramsTask.KEY)
    private repairTrashedProgramsTaskFactory: () => RepairTrashedProgramsTask,
    @inject(SyncSmartFillerListsTask.KEY)
    private syncSmartFillerListsTaskFactory: () => SyncSmartFillerListsTask,
  ) {}

  async addLocal({
    mediaSourceId,
    forceScan,
    pathFilter,
  }: LocalScanRequest): Promise<boolean> {
    const mediaSource = await this.mediaSourceDB.getById(mediaSourceId);
    if (!mediaSource) {
      this.logger.error('No media source find with ID %s', mediaSourceId);
      return false;
    }

    const mediaSourceType = mediaSource.type;
    if (mediaSourceType !== 'local') {
      this.logger.error(
        'Scanning remote libraries is not supported by this scanner',
      );
      return false;
    }

    try {
      const lock = tryAcquire(
        await this.entityMutex.getLockForMediaSource(mediaSource),
      );
      const releaser = await lock.acquire();
      const scanner = Result.attempt(() =>
        this.localScannerFactory(mediaSource.mediaType!),
      ).orNull();

      if (!scanner) {
        this.logger.error(
          'Could not create scanner for media source: %O',
          mediaSource,
        );
        return false;
      }

      this.progressService.scanQueued(mediaSource.uuid);
      const controller = new AbortController();
      MediaSourceScanCoordinator.signalById.set(mediaSource.uuid, controller);
      MediaSourceScanCoordinator.queue
        .add(async () => {
          try {
            controller.signal.addEventListener('abort', () => {
              scanner.cancel();
            });
            await scanner.scan({ mediaSource, force: forceScan, pathFilter });
          } finally {
            releaser();
          }
        })
        .catch((e) =>
          this.logger.error(
            e,
            'Error scanning media source %s',
            mediaSource.uuid,
          ),
        )
        .finally(() => {
          MediaSourceScanCoordinator.signalById.delete(mediaSource.uuid);
          this.repairTrashedPrograms();
          this.reconcileProgramDurations();
          this.syncSmartFillerLists();
        });

      return true;
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        this.logger.error(
          'Could not acquire lock for mediaSource: %s',
          mediaSource.uuid,
        );
      } else {
        this.logger.error(
          e,
          'Error while scheduling scan for mediaSource: %s',
          mediaSource.uuid,
        );
      }
      return false;
    }
  }

  async add({
    libraryId,
    forceScan,
    pathFilter,
    notification = false,
    notificationToken,
    plexNotificationItem,
    onFinished,
    onCleanupRequested,
  }: ScanRequest): Promise<boolean> {
    const library = await this.mediaSourceDB.getLibrary(libraryId);

    if (!library) {
      this.logger.error('No library found with ID %s', libraryId);
      return false;
    }

    // Scanning a library the server no longer reports would mark all of its
    // programs missing.
    if (library.unavailableSince !== null) {
      this.logger.warn(
        "Skipping scan of library '%s' (ID = %s): unavailable since %s",
        library.name,
        library.uuid,
        library.unavailableSince.toISOString(),
      );
      return false;
    }

    if (
      notification &&
      (!library.enabled || library.mediaSource.type !== 'plex' || !pathFilter)
    ) {
      return false;
    }

    const mediaSourceType = library.mediaSource.type;
    if (mediaSourceType === 'local') {
      this.logger.error('Scanning local libraries is not supported by scanner');
      return false;
    }

    const scanner = Result.attempt(() =>
      this.scannerFactory(mediaSourceType, library.mediaType),
    ).orNull();

    if (!scanner) {
      this.logger.error('Could not create scanner for library: %O', library);
      return false;
    }

    const enqueueScan = (releaser: MutexInterface.Releaser) => {
      try {
        const collectionScanner = this.collectionScannerFactory(
          library.mediaSource.type,
        );

        this.progressService.scanQueued(library.uuid);
        const controller = new AbortController();
        MediaSourceScanCoordinator.signalById.set(library.uuid, controller);
        if (notification) {
          MediaSourceScanCoordinator.notificationOnlyLibraries.add(
            library.uuid,
          );
        }
        MediaSourceScanCoordinator.queue
          .add(async () => {
            controller.signal.addEventListener('abort', () => {
              scanner.cancel(library.uuid);
            });
            if (notification && controller.signal.aborted) return;
            if (
              notification &&
              (library.mediaType === 'movies' ||
                plexNotificationItem?.type === 'episode')
            ) {
              this.progressService.scanStarted(library.uuid);
              (
                await scanner.scanSingle({
                  library,
                  externalId: pathFilter!,
                  force: false,
                  notification,
                  notificationToken,
                  plexNotificationItem,
                })
              ).getOrThrow();
            } else {
              await scanner.scan({
                library,
                force: forceScan,
                pathFilter,
                notification,
                notificationToken,
                plexNotificationItem,
              });
            }
            if (collectionScanner && !notification) {
              await collectionScanner.scanLibrary({
                libraryId: library.uuid,
                force: forceScan,
              });
            }
          })
          .catch((e) =>
            this.logger.error(e, 'Error scanning library %s', library.uuid),
          )
          .finally(() => {
            try {
              MediaSourceScanCoordinator.signalById.delete(library.uuid);
              try {
                if (notification && onCleanupRequested) onCleanupRequested();
                else this.runPostScanTasks();
              } finally {
                if (notification) this.progressService.scanEnded(library.uuid);
                onFinished?.();
              }
            } finally {
              if (notification) {
                MediaSourceScanCoordinator.notificationOnlyLibraries.delete(
                  library.uuid,
                );
              }
              releaser();
            }
          });

        return true;
      } catch (e) {
        releaser();
        throw e;
      }
    };

    try {
      const lock = await this.entityMutex.getLockForLibrary(library);
      const waitForNotification =
        !notification &&
        !pathFilter &&
        MediaSourceScanCoordinator.notificationOnlyLibraries.delete(
          library.uuid,
        );
      if (waitForNotification) {
        this.logger.info(
          'Deferring scan of library %s until its notification finishes',
          library.uuid,
        );
        // Reserve the mutex turn now, but acknowledge without waiting for the
        // notification (which may itself be queued behind another library).
        void lock
          .acquire()
          .then(enqueueScan)
          .catch((e) =>
            this.logger.error(
              e,
              'Error while scheduling deferred scan for library: %s',
              library.uuid,
            ),
          );
        return true;
      }
      return enqueueScan(await tryAcquire(lock).acquire());
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        this.logger.error(
          'Could not acquire lock for library: %s',
          library.uuid,
        );
      } else {
        this.logger.error(
          e,
          'Error while scheduling scan for library: %s',
          library.uuid,
        );
      }
      return false;
    }
  }

  runPostScanTasks() {
    this.repairTrashedPrograms();
    this.reconcileProgramDurations();
    this.syncSmartFillerLists();
  }

  // A scan can change program durations. Channel lineups keep their own copy,
  // which streaming schedules from, so it is brought back in line here.
  private reconcileProgramDurations() {
    GlobalScheduler.runTask(this.reconcileDurationsTaskFactory(), undefined);
  }

  // A scan can re-add items under new IDs, trashing the old records.
  private repairTrashedPrograms() {
    GlobalScheduler.runTask(this.repairTrashedProgramsTaskFactory(), undefined);
  }

  // A scan can change which clips a smart collection matches.
  private syncSmartFillerLists() {
    GlobalScheduler.runTask(this.syncSmartFillerListsTaskFactory(), undefined);
  }

  cancelAll() {
    for (const controller of MediaSourceScanCoordinator.signalById.values()) {
      controller.abort();
    }
  }

  awaitAllFinished() {
    return MediaSourceScanCoordinator.queue.onEmpty();
  }
}

type ScanRequest = {
  onCleanupRequested?: () => void;
  notification?: boolean;
  notificationToken?: object;
  plexNotificationItem?: PlexMovie | PlexEpisode;
  onFinished?: () => void;
  libraryId: string;
  forceScan: boolean;
  pathFilter?: string;
};

type LocalScanRequest = {
  mediaSourceId: MediaSourceId;
  forceScan: boolean;
  pathFilter?: string;
};
