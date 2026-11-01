import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import type { Movie } from '../types/Media.ts';
import type { ScanContext } from './scanner/MediaSourceScanner.ts';
import { Result } from '../types/result.ts';
import type { EntityMutex } from './EntityMutex.ts';
import { PlexNotificationRefreshes } from './scanner/PlexNotificationRefreshes.ts';
import { PlexNotificationService } from './PlexNotificationService.ts';
import type { MediaSourceScanCoordinator } from './scanner/MediaSourceScanCoordinator.ts';

vi.mock('./scanner/MediaSourceScanCoordinator.ts', () => ({
  MediaSourceScanCoordinator: class {},
}));
vi.mock('../external/MediaSourceApiFactory.ts', () => ({
  MediaSourceApiFactory: class {},
}));

class FakeSocket {
  static CLOSED = 3;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

describe('Plex metadata-read notification echo', () => {
  let service: PlexNotificationService | undefined;
  afterEach(() => {
    service?.stop();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does not recursively refresh when metadata reads emit finished events', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TUNARR_PLEX_NOTIFICATIONS', 'true');
    const sockets: FakeSocket[] = [];
    class Socket extends FakeSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', Socket);
    const source = {
      uuid: 'source',
      type: 'plex',
      uri: 'http://localhost:32400',
      accessToken: 'fixture',
      libraries: [
        {
          uuid: 'library',
          mediaSourceId: 'source',
          externalKey: '1',
          enabled: true,
          unavailableSince: null,
          mediaType: 'movies',
        },
      ],
    };
    const emitFinished = () =>
      sockets[0].onmessage?.({
        data: JSON.stringify({
          NotificationContainer: {
            type: 'timeline',
            TimelineEntry: [
              {
                identifier: 'com.plexapp.plugins.library',
                sectionID: '1',
                itemID: '10',
                state: 5,
                metadataState: 'finished',
              },
            ],
          },
        }),
      });
    const getItemMetadataRaw = vi.fn().mockImplementation(async () => {
      // The Plex trial emitted this sequence from a metadata GET itself.
      emitFinished();
      return Result.success({
        type: 'movie',
        ratingKey: '10',
        librarySectionID: 1,
      });
    });
    const refreshes = new PlexNotificationRefreshes();
    const context = {
      library: source.libraries[0],
      mediaSource: source,
      force: false,
    } as unknown as ScanContext<unknown>;
    const item = {
      externalId: '10',
      canonicalId: 'full',
      title: 'Movie',
    } as Movie;
    const add = vi
      .fn()
      .mockImplementation(
        async ({
          onFinished,
          notificationToken,
        }: {
          onFinished: () => void;
          notificationToken?: object;
        }) => {
          emitFinished();
          refreshes.record(
            { ...context, notification: true, notificationToken },
            item,
          );
          onFinished();
          return true;
        },
      );
    service = new PlexNotificationService(
      {
        findByType: async () => [source],
        getLibrary: async () => ({
          ...source.libraries[0],
          mediaSource: source,
        }),
      } as unknown as MediaSourceDB,
      {
        getPlexApiClientForMediaSource: async () => ({ getItemMetadataRaw }),
      } as unknown as MediaSourceApiFactory,
      { add } as unknown as MediaSourceScanCoordinator,
      { isLibraryLocked: () => false } as unknown as EntityMutex,
      refreshes,
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].onopen?.();
    emitFinished();
    emitFinished();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(add).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    emitFinished();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(add).toHaveBeenCalledTimes(1);
    expect(getItemMetadataRaw).toHaveBeenCalledTimes(1);
    expect(refreshes.consume(context, item, item.canonicalId)).toBe(true);
  });
});
