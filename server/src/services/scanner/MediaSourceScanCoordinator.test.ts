import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import { Result } from '../../types/result.ts';
import { MutexMap } from '../../util/mutexMap.ts';
import { EntityMutex } from '../EntityMutex.ts';
import type { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import { MediaSourceScanCoordinator } from './MediaSourceScanCoordinator.ts';
import type { GenericMediaSourceScannerFactory } from './MediaSourceScanner.ts';

vi.mock('../Scheduler.ts', () => ({
  GlobalScheduler: { runTask: vi.fn() },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('full scan contention with a Plex notification', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { queued: false, targetedFirst: false },
    { queued: true, targetedFirst: false },
    { queued: false, targetedFirst: true },
    { queued: true, targetedFirst: true },
  ])(
    'retains one full scan behind a notification (queued: $queued, targeted rescan first: $targetedFirst)',
    async ({ queued, targetedFirst }) => {
      vi.useFakeTimers();
      const releaseOther = deferred();
      const releaseNotification = deferred();
      const finishedNotification = deferred();
      const finishedFullScan = deferred();
      const order: string[] = [];
      const scan = vi.fn(async ({ library }: { library: { uuid: string } }) => {
        if (library.uuid === 'other') await releaseOther.promise;
        else order.push('full scan');
      });
      const scanSingle = vi.fn(async () => {
        await releaseNotification.promise;
        order.push('notification');
        return Result.success(undefined);
      });
      const coordinator = new MediaSourceScanCoordinator(
        {
          getLibrary: vi.fn(async (uuid: string) => ({
            uuid,
            mediaSourceId: 'source',
            enabled: true,
            unavailableSince: null,
            mediaType: 'movies',
            mediaSource: { type: 'plex' },
          })),
        } as unknown as MediaSourceDB,
        new EntityMutex(new MutexMap()),
        (() => ({
          scan,
          scanSingle,
          cancel: vi.fn(),
        })) as unknown as GenericMediaSourceScannerFactory,
        vi.fn(),
        {
          scanQueued: vi.fn(),
          scanStarted: vi.fn(),
          scanEnded: vi.fn(),
        } as unknown as MediaSourceProgressService,
        () => undefined,
        vi.fn(),
        vi.fn(),
        vi.fn(),
      );
      let targetedScan: Promise<boolean> | undefined;
      let targetedAccepted: boolean | undefined;
      try {
        if (queued) {
          expect(
            await coordinator.add({ libraryId: 'other', forceScan: false }),
          ).toBe(true);
        }
        expect(
          await coordinator.add({
            libraryId: 'library',
            forceScan: false,
            notification: true,
            pathFilter: 'episode',
            onFinished: finishedNotification.resolve,
          }),
        ).toBe(true);
        if (targetedFirst) {
          targetedScan = coordinator
            .add({
              libraryId: 'library',
              forceScan: true,
              pathFilter: 'movie',
            })
            .then((accepted) => {
              targetedAccepted = accepted;
              return accepted;
            });
          await vi.runAllTimersAsync();
        }
        let fullScanSettled = false;
        const fullScan = coordinator
          .add({
            libraryId: 'library',
            forceScan: false,
            onFinished: finishedFullScan.resolve,
          })
          .then((accepted) => {
            fullScanSettled = true;
            return accepted;
          });
        await vi.runAllTimersAsync();
        expect(fullScanSettled).toBe(true);
        expect(await fullScan).toBe(true);
        expect(order).toEqual([]);
        expect(scan).toHaveBeenCalledTimes(queued ? 1 : 0);
        if (targetedFirst) expect(targetedAccepted).toBe(false);

        const duplicate = coordinator.add({
          libraryId: 'library',
          forceScan: false,
        });
        await vi.runAllTimersAsync();
        expect(await duplicate).toBe(false);

        releaseOther.resolve();
        releaseNotification.resolve();
        expect(await fullScan).toBe(true);
        await finishedFullScan.promise;
        expect(order).toEqual(['notification', 'full scan']);
        expect(scanSingle).toHaveBeenCalledTimes(1);
        expect(scan).toHaveBeenCalledTimes(queued ? 2 : 1);
      } finally {
        releaseOther.resolve();
        releaseNotification.resolve();
        await finishedNotification.promise;
        await targetedScan;
      }
    },
  );
});
