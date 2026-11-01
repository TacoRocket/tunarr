import { MediaSourceDB } from '@/db/mediaSourceDB.js';
import { MediaSourceType } from '@/db/schema/base.js';
import { MediaSourceApiFactory } from '@/external/MediaSourceApiFactory.js';
import type {
  GetSubtitlesRequest,
  ScanContext,
} from '@/services/scanner/MediaSourceScanner.js';
import { inject, injectable } from 'inversify';
import { ProgramConverter } from '../../db/converters/ProgramConverter.ts';
import type { ProgramDaoMinter } from '../../db/converters/ProgramMinter.ts';
import { type IProgramDB } from '../../db/interfaces/IProgramDB.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.js';
import type { QueryResult } from '../../external/BaseApiClient.ts';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import { KEYS } from '../../types/inject.ts';
import type { PlexMovie } from '../../types/Media.ts';
import { Result } from '../../types/result.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { MeilisearchService } from '../MeilisearchService.ts';
import { MediaSourceMovieLibraryScanner } from './MediaSourceMovieLibraryScanner.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import { PlexNotificationRefreshes } from './PlexNotificationRefreshes.ts';
import { PlexScanUtil } from './PlexScanUtil.ts';
import { PlexScanMetadataBatch } from './PlexScanMetadataBatch.ts';

@injectable()
export class PlexMediaSourceMovieScanner extends MediaSourceMovieLibraryScanner<
  typeof MediaSourceType.Plex,
  PlexApiClient
> {
  private readonly scanMetadata = new PlexScanMetadataBatch<PlexMovie>();

  readonly mediaSourceType = MediaSourceType.Plex;

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(MediaSourceDB) mediaSourceDB: MediaSourceDB,
    @inject(KEYS.ProgramDB) programDB: IProgramDB,
    @inject(MediaSourceApiFactory)
    private mediaSourceApiFactory: MediaSourceApiFactory,
    @inject(KEYS.ProgramDaoMinterFactory)
    programMinterFactory: () => ProgramDaoMinter,
    @inject(MediaSourceProgressService)
    mediaSourceProgressService: MediaSourceProgressService,
    @inject(MeilisearchService) searchService: MeilisearchService,
    @inject(ProgramConverter) programConverter: ProgramConverter,
    @inject(ExternalSubtitleDownloader)
    externalSubtitleDownloader: ExternalSubtitleDownloader,
    @inject(PlexNotificationRefreshes)
    private readonly refreshes: PlexNotificationRefreshes,
  ) {
    super(
      mediaSourceDB,
      programDB,
      mediaSourceProgressService,
      searchService,
      programConverter,
      programMinterFactory(),
      externalSubtitleDownloader,
    );
  }

  protected shouldSkipItem(
    context: ScanContext<PlexApiClient>,
    item: PlexMovie,
    canonicalId?: string | null,
  ): boolean {
    const reused = this.refreshes.consume(context, item, canonicalId);
    if (reused)
      this.logger.debug(
        'Reusing successful Plex notification refresh for item %s',
        item.externalId,
      );
    return reused;
  }

  protected recordItemRefresh(
    context: ScanContext<PlexApiClient>,
    item: PlexMovie,
  ): void {
    this.refreshes.record(context, item);
  }

  protected getApiClient(
    mediaSource: MediaSourceWithRelations,
  ): Promise<PlexApiClient> {
    return this.mediaSourceApiFactory.getPlexApiClientForMediaSource(
      mediaSource,
    );
  }

  protected getLibrarySize(
    libraryKey: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<number> {
    return context.apiClient
      .getLibraryCount(libraryKey)
      .then((_) => _.getOrThrow());
  }

  protected getLibraryContents(
    libraryKey: string,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexMovie> {
    return this.scanMetadata.iterate(
      context.apiClient.getMovieLibraryContents(libraryKey),
      (keys) => context.apiClient.getMoviesForScan(keys),
      () => this.state(context.library.uuid) === 'canceled',
      context.pathFilter,
      (item) => !this.refreshes.has(context, item),
    );
  }

  protected async scanMovie(
    context: ScanContext<PlexApiClient>,
    incomingMovie: PlexMovie,
  ): Promise<Result<PlexMovie>> {
    // Notification movies enter through scanSingle, which already fetched full
    // metadata with scanMovieById; do not fetch the same item again.
    if (context.notification) return Result.success(incomingMovie);
    return (
      this.scanMetadata.take(incomingMovie) ??
      context.apiClient.getMovie(incomingMovie.externalId)
    );
  }

  protected async scanMovieById(
    context: ScanContext<PlexApiClient>,
    externalId: string,
  ): Promise<Result<PlexMovie>> {
    if (
      context.notification &&
      context.plexNotificationItem?.type === 'movie' &&
      context.plexNotificationItem.externalId === externalId
    ) {
      return Result.success(context.plexNotificationItem);
    }
    return context.apiClient.getMovie(externalId);
  }

  protected getSubtitles(
    context: ScanContext<PlexApiClient>,
    { key }: GetSubtitlesRequest,
  ): Promise<QueryResult<string>> {
    return PlexScanUtil.getSubtitles(context, key);
  }
}
