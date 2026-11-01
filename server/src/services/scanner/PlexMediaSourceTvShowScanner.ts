import { MediaSourceDB } from '@/db/mediaSourceDB.js';
import { MediaSourceApiFactory } from '@/external/MediaSourceApiFactory.js';
import type {
  GetSubtitlesRequest,
  ScanContext,
  ScanSingleRequest,
} from '@/services/scanner/MediaSourceScanner.js';
import type { ProgramGrouping } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { GetProgramGroupingById } from '../../commands/GetProgramGroupingById.ts';
import { ProgramGroupingMinter } from '../../db/converters/ProgramGroupingMinter.ts';
import type { ProgramDaoMinter } from '../../db/converters/ProgramMinter.ts';
import { type IProgramDB } from '../../db/interfaces/IProgramDB.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.js';
import type { QueryResult } from '../../external/BaseApiClient.ts';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { WrappedError } from '../../types/errors.ts';
import { KEYS } from '../../types/inject.ts';
import type {
  PlexEpisode,
  PlexSeason,
  PlexShow,
  SeasonWithShow,
} from '../../types/Media.ts';
import { Result } from '../../types/result.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { MeilisearchService } from '../MeilisearchService.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import { MediaSourceTvShowLibraryScanner } from './MediaSourceTvShowLibraryScanner.ts';
import { PlexNotificationRefreshes } from './PlexNotificationRefreshes.ts';
import { PlexScanUtil } from './PlexScanUtil.ts';
import { PlexScanMetadataBatch } from './PlexScanMetadataBatch.ts';

@injectable()
export class PlexMediaSourceTvShowScanner extends MediaSourceTvShowLibraryScanner<
  'plex',
  PlexApiClient,
  PlexShow,
  PlexSeason,
  PlexEpisode
> {
  readonly mediaSourceType = 'plex';

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(MediaSourceDB) mediaSourceDB: MediaSourceDB,
    @inject(KEYS.ProgramDB) programDB: IProgramDB,
    @inject(MediaSourceApiFactory)
    private mediaSourceApiFactory: MediaSourceApiFactory,
    @inject(KEYS.ProgramDaoMinterFactory)
    programMinterFactory: () => ProgramDaoMinter,
    @inject(ProgramGroupingMinter)
    programGroupingMinter: ProgramGroupingMinter,
    @inject(MeilisearchService) searchService: MeilisearchService,
    @inject(MediaSourceProgressService)
    mediaSourceProgressService: MediaSourceProgressService,
    @inject(GetProgramGroupingById)
    getProgramGroupingsById: GetProgramGroupingById,
    @inject(ExternalSubtitleDownloader)
    externalSubtitleDownloader: ExternalSubtitleDownloader,
    @inject(PlexNotificationRefreshes)
    private readonly refreshes: PlexNotificationRefreshes,
  ) {
    super(
      mediaSourceDB,
      programDB,
      programGroupingMinter,
      programMinterFactory(),
      searchService,
      mediaSourceProgressService,
      getProgramGroupingsById,
      externalSubtitleDownloader,
    );
  }

  override async scanSingle(request: ScanSingleRequest): Promise<Result<void>> {
    const episode = request.plexNotificationItem;
    if (!request.notification || episode?.type !== 'episode') {
      return super.scanSingle(request);
    }
    return Result.attemptAsync(async () => {
      const { library } = request;
      const mediaSource = await this.mediaSourceDB.getById(
        library.mediaSourceId,
      );
      if (
        !mediaSource ||
        episode.mediaSourceId !== mediaSource.uuid ||
        episode.libraryId !== library.uuid
      ) {
        throw new Error(
          'Plex notification episode does not belong to this source and library',
        );
      }
      const showId = episode.season?.show?.externalId;
      const seasonId = episode.season?.externalId;
      if (!showId || !seasonId)
        throw new Error(
          'Plex episode notification has no show/season identity; normal scan remains the fallback',
        );

      const fallback = () => {
        this.logger.info(
          'Plex episode %s needs parent discovery; refreshing show %s',
          episode.externalId,
          showId,
        );
        return this.scan({ ...request, pathFilter: showId });
      };
      const lookup = (externalKey: string) =>
        this.programDB.getProgramGroupingByExternalId({
          sourceType: 'plex',
          externalSourceId: mediaSource.uuid,
          externalKey,
        });
      const [savedShow, savedSeason] = await Promise.all([
        lookup(showId),
        lookup(seasonId),
      ]);
      if (
        savedShow?.type !== 'show' ||
        savedSeason?.type !== 'season' ||
        savedShow.libraryId !== library.uuid ||
        savedSeason.libraryId !== library.uuid ||
        savedSeason.showUuid !== savedShow.uuid ||
        savedShow.state !== 'ok' ||
        savedSeason.state !== 'ok'
      ) {
        await fallback();
        return;
      }
      const [show, season] = await Promise.all([
        this.getProgramGroupingByIdCommand.execute(savedShow.uuid),
        this.getProgramGroupingByIdCommand.execute(savedSeason.uuid),
      ]);
      if (
        !show ||
        !this.isShowT(show) ||
        !season ||
        !this.isSeasonT(season) ||
        season.index !== episode.season?.index
      ) {
        await fallback();
        return;
      }
      const existing = await this.programDB.lookupByExternalId({
        sourceType: 'plex',
        externalSourceId: mediaSource.uuid,
        externalKey: episode.externalId,
      });
      const context: ScanContext<PlexApiClient> = {
        library,
        mediaSource,
        apiClient: await this.getApiClient(mediaSource),
        force:
          !!request.force ||
          (!!existing &&
            (existing.tvShowUuid !== show.uuid ||
              existing.seasonUuid !== season.uuid)),
        notification: true,
        notificationToken: request.notificationToken,
        plexNotificationItem: episode,
        scannedEntities: 0,
        totalEntities: 1,
      };
      await this.importEpisode(
        episode,
        show,
        { ...season, show },
        existing?.canonicalId,
        context,
      );
    });
  }

  protected async *getTvShowLibraryContents(
    libraryId: string,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexShow> {
    if (context.notification && context.pathFilter) {
      yield (await context.apiClient.getShow(context.pathFilter)).getOrThrow();
      return;
    }
    yield* context.apiClient.getTvShowLibraryContents(libraryId);
  }

  protected getTvShowSeasons(
    show: PlexShow,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexSeason> {
    return context.apiClient.getShowSeasons(show.externalId);
  }

  private readonly scanMetadata = new PlexScanMetadataBatch<PlexEpisode>();

  protected getSeasonEpisodes(
    season: SeasonWithShow<PlexSeason, PlexShow>,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexEpisode> {
    return this.scanMetadata.iterate(
      context.apiClient.getSeasonEpisodes(
        season.show.externalId,
        season.externalId,
      ),
      (keys) => context.apiClient.getEpisodesForScan(keys),
      () => this.state(context.library.uuid) === 'canceled',
      undefined,
      (item) => !this.refreshes.has(context, item),
    );
  }

  protected getFullEpisodeMetadata(
    episodeT: PlexEpisode,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexEpisode, WrappedError>> {
    if (
      context.notification &&
      context.plexNotificationItem?.type === 'episode' &&
      context.plexNotificationItem.externalId === episodeT.externalId
    ) {
      return Promise.resolve(Result.success(context.plexNotificationItem));
    }
    return Promise.resolve(
      this.scanMetadata.take(episodeT) ??
        context.apiClient.getEpisode(episodeT.externalId),
    );
  }

  protected getFullTvShowMetadata(
    externalId: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexShow, WrappedError>> {
    return context.apiClient.getShow(externalId);
  }

  protected getFullTvSeasonMetadata(
    externalId: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexSeason, WrappedError>> {
    return context.apiClient.getSeason(externalId);
  }

  protected shouldSkipItem(
    context: ScanContext<PlexApiClient>,
    item: PlexEpisode,
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
    item: PlexEpisode,
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

  protected getEntityExternalKey(
    item: PlexShow | PlexSeason | PlexEpisode,
  ): string {
    return item.externalId;
  }

  protected getLibrarySize(
    libraryKey: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<number> {
    return context.apiClient
      .getLibraryCount(libraryKey)
      .then((_) => _.getOrThrow());
  }

  protected isShowT(grouping: ProgramGrouping): grouping is PlexShow {
    return grouping.sourceType === 'plex' && grouping.type === 'show';
  }

  protected isSeasonT(grouping: ProgramGrouping): grouping is PlexSeason {
    return grouping.sourceType === 'plex' && grouping.type === 'season';
  }

  protected getSubtitles(
    context: ScanContext<PlexApiClient>,
    { key }: GetSubtitlesRequest,
  ): Promise<QueryResult<string>> {
    return PlexScanUtil.getSubtitles(context, key);
  }
}
