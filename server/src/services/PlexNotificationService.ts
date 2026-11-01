import { inject, injectable } from 'inversify';
import { z } from 'zod/v4';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import { getBooleanEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { EntityMutex } from './EntityMutex.ts';
import { MediaSourceScanCoordinator } from './scanner/MediaSourceScanCoordinator.ts';

const TimelineEntry = z.object({
  identifier: z.literal('com.plexapp.plugins.library'),
  sectionID: z.union([z.string(), z.number()]).transform(String),
  itemID: z.union([z.string(), z.number()]).transform(String),
  state: z.number(),
  metadataState: z.string().optional(),
});
const Notification = z.object({
  NotificationContainer: z.object({
    type: z.literal('timeline'),
    TimelineEntry: z.array(z.unknown()),
  }),
});

type Connection = {
  source: MediaSourceWithRelations;
  socket: WebSocket;
  timeout: ReturnType<typeof setTimeout>;
};
type PendingItem = {
  sourceId: MediaSourceWithRelations['uuid'];
  libraryId: string;
  itemId: string;
};

/** Plex events are hints; normal scans remain authoritative for missed changes. */
@injectable()
export class PlexNotificationService {
  @InjectLogger() declare private readonly logger: Logger;
  private connections = new Map<string, Connection>();
  private pending = new Map<string, PendingItem>();
  private suppressedUntil = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private reconciling = false;
  private draining = false;
  private activeLibrary?: string;

  constructor(
    @inject(MediaSourceDB) private readonly sources: MediaSourceDB,
    @inject(MediaSourceApiFactory)
    private readonly clients: MediaSourceApiFactory,
    @inject(MediaSourceScanCoordinator)
    private readonly scans: MediaSourceScanCoordinator,
    @inject(EntityMutex) private readonly mutex: EntityMutex,
  ) {}

  start() {
    if (
      this.timer ||
      !getBooleanEnvVar(TUNARR_ENV_VARS.PLEX_NOTIFICATIONS, false)
    )
      return;
    this.logger.info(
      'Plex notifications enabled; normal scan schedule remains unchanged',
    );
    this.timer = setInterval(() => void this.reconcile(), 30_000);
    this.timer.unref();
    void this.reconcile();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.pending.clear();
    this.suppressedUntil.clear();
    for (const connection of this.connections.values()) this.close(connection);
    this.connections.clear();
  }

  private close(connection: Connection) {
    clearTimeout(connection.timeout);
    connection.socket.onmessage = null;
    connection.socket.onclose = null;
    connection.socket.onerror = null;
    connection.socket.onopen = null;
    connection.socket.close();
  }

  private async reconcile() {
    if (this.reconciling || !this.timer) return;
    this.reconciling = true;
    try {
      const sources = await this.sources.findByType('plex');
      if (!this.timer) return;
      const eligible = sources.filter((source) =>
        source.libraries.some(
          (library) =>
            library.enabled &&
            library.unavailableSince === null &&
            (library.mediaType === 'movies' || library.mediaType === 'shows'),
        ),
      );
      for (const [id, connection] of this.connections) {
        const source = eligible.find((candidate) => candidate.uuid === id);
        if (
          !source ||
          source.uri !== connection.source.uri ||
          source.accessToken !== connection.source.accessToken ||
          connection.socket.readyState === WebSocket.CLOSED
        ) {
          this.close(connection);
          this.connections.delete(id);
          for (const [key, item] of this.pending)
            if (item.sourceId === id) this.pending.delete(key);
        } else {
          connection.source = source;
        }
      }
      for (const source of eligible) {
        if (this.connections.has(source.uuid)) continue;
        try {
          const url = new URL(source.uri);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          url.pathname = `${url.pathname.replace(/\/$/, '')}/:/websockets/notifications`;
          url.search = '';
          url.searchParams.set('X-Plex-Token', source.accessToken);
          const socket = new WebSocket(url);
          const timeout = setTimeout(() => socket.close(), 15_000);
          const connection = { source, socket, timeout };
          this.connections.set(source.uuid, connection);
          socket.onopen = () => {
            clearTimeout(timeout);
            this.logger.info(
              'Plex notifications connected for source %s; gaps remain covered by normal scans',
              source.uuid,
            );
          };
          socket.onmessage = (event) => this.receive(connection, event.data);
          socket.onerror = () => socket.close();
          socket.onclose = () => {
            clearTimeout(timeout);
            this.logger.warn(
              'Plex notifications disconnected for source %s; retrying within 30 seconds, normal scans remain enabled',
              source.uuid,
            );
          };
        } catch {
          // Do not log WebSocket errors/URLs: the URL carries the Plex token.
          this.logger.warn(
            'Could not connect Plex notifications for source %s; normal scans remain enabled',
            source.uuid,
          );
        }
      }
      for (const [id, until] of this.suppressedUntil)
        if (until <= Date.now()) this.suppressedUntil.delete(id);
    } catch {
      this.logger.warn(
        'Could not refresh Plex notification connections; retrying within 30 seconds',
      );
    } finally {
      this.reconciling = false;
    }
  }

  private receive(connection: Connection, data: unknown) {
    if (!this.timer || typeof data !== 'string' || data.length > 1_048_576)
      return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.logger.debug('Ignoring malformed Plex notification');
      return;
    }
    const parsed = Notification.safeParse(message);
    if (!parsed.success) return;
    for (const row of parsed.data.NotificationContainer.TimelineEntry) {
      const entry = TimelineEntry.safeParse(row);
      if (!entry.success) continue;
      const { sectionID, itemID, state, metadataState } = entry.data;
      if (
        state !== 5 ||
        metadataState === 'processing' ||
        !/^\d+$/.test(itemID)
      )
        continue;
      const library = connection.source.libraries.find(
        (lib) => lib.externalKey === sectionID,
      );
      if (
        !library?.enabled ||
        library.unavailableSince !== null ||
        (library.mediaType !== 'movies' && library.mediaType !== 'shows')
      )
        continue;
      // Plex metadata reads themselves emitted timeline events in the trial.
      // Suppress scan echoes, including their short tail, rather than recursively scanning.
      if (
        this.activeLibrary === library.uuid ||
        this.mutex.isLibraryLocked(library) ||
        (this.suppressedUntil.get(library.uuid) ?? 0) > Date.now()
      ) {
        this.logger.debug(
          'Plex notification deferred to normal scan for busy library %s',
          library.uuid,
        );
        continue;
      }
      const key = `${connection.source.uuid}:${itemID}`;
      if (!this.pending.has(key) && this.pending.size >= 100) {
        this.logger.warn(
          'Plex notification queue full; further changes deferred to normal scan',
        );
        continue;
      }
      this.pending.set(key, {
        sourceId: connection.source.uuid,
        libraryId: library.uuid,
        itemId: itemID,
      });
    }
    this.scheduleDrain();
  }

  private scheduleDrain() {
    if (
      !this.timer ||
      this.draining ||
      this.drainTimer ||
      this.pending.size === 0
    )
      return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, 5_000);
  }

  private async drain() {
    if (!this.timer || this.draining) return;
    this.draining = true;
    const refreshed = new Set<string>();
    try {
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const item of batch) {
        if (!this.timer) break;
        this.activeLibrary = item.libraryId;
        try {
          const library = await this.sources.getLibrary(item.libraryId);
          if (
            !this.timer ||
            !library?.enabled ||
            library.unavailableSince !== null ||
            library.mediaSourceId !== item.sourceId ||
            library.mediaSource.type !== 'plex' ||
            this.mutex.isLibraryLocked(library)
          )
            continue;
          const client = await this.clients.getPlexApiClientForMediaSource(
            library.mediaSource,
          );
          const media = (
            await client.getItemMetadataRaw(item.itemId)
          ).getOrThrow();
          if (
            !('librarySectionID' in media) ||
            String(media.librarySectionID) !== library.externalKey
          )
            continue;
          const target =
            media.type === 'movie' && library.mediaType === 'movies'
              ? media.ratingKey
              : library.mediaType === 'shows'
                ? media.type === 'show'
                  ? media.ratingKey
                  : media.type === 'season'
                    ? media.parentRatingKey
                    : media.type === 'episode'
                      ? media.grandparentRatingKey
                      : undefined
                : undefined;
          if (!target || !this.timer) continue;
          const targetKey = `${library.uuid}:${target}`;
          if (refreshed.has(targetKey)) continue;
          let finished!: () => void;
          const completion = new Promise<void>((resolve) => {
            finished = resolve;
          });
          const accepted = await this.scans.add({
            libraryId: library.uuid,
            forceScan: false,
            pathFilter: String(target),
            notification: true,
            onFinished: finished,
          });
          if (accepted) {
            refreshed.add(targetKey);
            this.logger.info(
              'Plex notification queued targeted refresh of %s in library %s',
              target,
              library.uuid,
            );
            await completion;
          } else {
            this.logger.debug(
              'Plex notification refresh deferred to normal scan for library %s',
              library.uuid,
            );
          }
        } catch {
          this.logger.warn(
            'Plex notification refresh failed for item %s; normal scan remains the fallback',
            item.itemId,
          );
        } finally {
          this.suppressedUntil.set(item.libraryId, Date.now() + 5_000);
          this.activeLibrary = undefined;
        }
      }
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }
}
