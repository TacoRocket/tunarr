import {
  findReusableEnglishText,
  ProgramSubtitlePreparation,
  ProgramSubtitleRequest,
  requestMissingSubtitle,
  type ProgramSubtitleResult,
} from '../services/subtitles/ProgramSubtitlePreparation.ts';
import type { LineupRepository } from '../db/channel/LineupRepository.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import {
  hasSubtitleCache,
  recordSubtitleCache,
  retireReplacedSubtitleCache,
  subtitleSourceIdentity,
  sweepSubtitleCache,
} from '../services/subtitles/SubtitleCache.ts';
import type { IFillerListDB } from '../db/interfaces/IFillerListDB.ts';
import { StreamSelectionProfileResolver } from '../services/StreamSelectionProfileResolver.ts';
import dayjs from 'dayjs';
import { Mutex } from 'async-mutex';
import { inject, injectable } from 'inversify';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path, { dirname, extname } from 'node:path';
import { devNull } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpName } from 'tmp-promise';
import z from 'zod';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type {
  MediaSourceWithRelations,
  ProgramWithRelationsOrm,
} from '../db/schema/derivedTypes.js';
import type { ProgramSubtitles } from '../db/schema/ProgramSubtitles.ts';
import { QueryError, type QueryResult } from '../external/BaseApiClient.ts';
import { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import { StreamSelector } from '../ffmpeg/StreamSelector.ts';
import type { StreamSource, SubtitleStreamDetails } from '../stream/types.ts';
import { HttpReconnectOptions } from '../ffmpeg/builder/options/input/HttpReconnectOptions.ts';
import type { GlobalOptions } from '../globals.ts';
import { TVGuideService } from '../services/TvGuideService.ts';
import { ExternalSubtitleDownloader } from '../stream/ExternalSubtitleDownloader.ts';
import { PathCalculator } from '../stream/PathCalculator.ts';
import { ProgramStreamDetailsFetcher } from '../stream/ProgramStreamDetailsFetcher.ts';
import { isImageBasedSubtitle } from '../stream/util.ts';
import { KEYS } from '../types/inject.ts';
import { OpenDateTimeRange } from '../types/OpenDateTimeRange.ts';
import { Result } from '../types/result.ts';
import { SubtitleExtractionProcess } from './SubtitleExtractionProcess.ts';
import {
  CacheFolderName,
  SubtitlesCacheFolderName,
} from '../util/constants.ts';
import { fileExists } from '../util/fsUtil.ts';
import { isNonEmptyString } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { getSubtitleCacheFilePath } from '../util/subtitles.ts';
import {
  createSubtitleMatroska,
  UnsupportedMatroskaError,
} from '../services/subtitles/SelectiveMatroskaReader.ts';
import { routesToEtvNext } from '../stream/etv/EtvNextRouting.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';

const ChannelExtractionFilter = z.object({
  type: z.literal('channel'),
  channelId: z.string(),
});

const ProgramExtractionFilter = ProgramSubtitleRequest.extend({
  type: z.literal('program'),
});

const DurationExtractionFilter = z.object({
  type: z.literal('time'),
  durationMs: z.number(),
});

type DurationExtractionFilter = z.infer<typeof DurationExtractionFilter>;

const ExtractionFilter = z.discriminatedUnion('type', [
  ChannelExtractionFilter,
  ProgramExtractionFilter,
  DurationExtractionFilter,
]);

const SubtitleExtractorTaskRequest = z.object({
  filter: ExtractionFilter.optional(),
});

type SubtitleExtractorTaskRequest = z.infer<
  typeof SubtitleExtractorTaskRequest
>;

const defaultFilter = {
  type: 'time',
  durationMs: dayjs.duration({ hours: 6 }).asMilliseconds(),
} satisfies DurationExtractionFilter;

const LookaheadBudgetMs = 10 * 60_000;
const LookaheadBudgetWindowMs = 60 * 60_000;
const UrgentLookaheadMs = 60 * 60_000;

// After an extraction fails, its file isn't read again for this long unless it
// changes. Hourly runs and guide rebuilds otherwise retry a file that can't
// finish over and over, each time reading it end to end (#81).
const FailedExtractionRetryMs = dayjs.duration({ hours: 6 }).asMilliseconds();

type PreparationContext = {
  channel: ChannelOrm;
  customShowId?: string;
  fillerListId?: string;
};

type ScheduledPreparation = {
  id: string;
  start: number;
  mediaSourceId: string;
  contexts: Map<string, PreparationContext>;
};

type ExtractionFile = {
  earliestAiring: number;
  source: StreamSource;
  revision: string | null;
  identity: string;
  progressStream: '0:v:0' | '0:a:0';
  mediaSourceIds: Set<string>;
  outputs: Map<
    string,
    { subtitle: SubtitleStreamDetails; outPath: string; programId: string }
  >;
};

type AutomaticPreparation = {
  request: ProgramSubtitleRequest;
  earliestAiring: number;
  identity: string;
  reuseExistingText: boolean;
  acceptText: (subtitle: SubtitleStreamDetails) => Promise<boolean>;
};

type AutomaticPreparationOutcome =
  | ProgramSubtitleResult
  | { status: 'failed'; message: string }
  | { status: 'deferred' };

type LookaheadPreparationResult = {
  programs: Array<{
    programId: string;
    sdh: boolean;
    result: AutomaticPreparationOutcome;
  }>;
  deferredExtractions: number;
};

@injectable()
@taskDef({
  name: SubtitleExtractorTask.name,
  description:
    'Extracts scheduled text subtitles; a program filter reuses text/cache, searches Plex, then tries English PGS OCR and optional subtitle requests',
  schema: SubtitleExtractorTaskRequest,
})
export class SubtitleExtractorTask extends Task2<
  typeof SubtitleExtractorTaskRequest,
  ProgramSubtitleResult | LookaheadPreparationResult | void
> {
  static KEY = SubtitleExtractorTask.name;
  static ID = SubtitleExtractorTask.name;
  private static extractionMutex = new Mutex();
  private static pendingFiles = new Map<string, Promise<boolean>>();
  private static acquisitionOutcomes = new Map<
    string,
    { checkedAt: number; result: AutomaticPreparationOutcome }
  >();
  // Guide updates share the hourly allowance; starting another task cannot refill it.
  private static lookaheadBudgets = new Map<
    string,
    { startedAt: number; spentMs: number }
  >();
  private static pendingPrograms = new Map<
    string,
    ReturnType<IProgramDB['getProgramById']>
  >();
  // Files whose last extraction failed. At most one entry per source path
  // that failed within FailedExtractionRetryMs; expired
  // entries are dropped at the start of every run, and a restart starts empty.
  private static failedExtractions = new Map<
    string,
    { source: string; failedAt: number }
  >();
  public ID = SubtitleExtractorTask.ID;

  schema = SubtitleExtractorTaskRequest;

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(TVGuideService) private guideService: TVGuideService,
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(ProgramStreamDetailsFetcher)
    private streamDetailsFetcher: ProgramStreamDetailsFetcher,
    @inject(MediaSourceDB) private mediaSourceDB: MediaSourceDB,
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
    @inject(KEYS.GlobalOptions) private globalOptions: GlobalOptions,
    @inject(KEYS.ProgramDB) private programDB: IProgramDB,
    @inject(ExternalSubtitleDownloader)
    private externalSubtitleDownloader: ExternalSubtitleDownloader,
    @inject(MediaSourceApiFactory)
    private mediaSourceApiFactory: MediaSourceApiFactory,
    @inject(StreamSelector) private streamSelector: StreamSelector,
    @inject(KEYS.DrizzleDB) private drizzleDB: DrizzleDBAccess,
    @inject(KEYS.LineupRepository) private lineups: LineupRepository,
    @inject(ProgramSubtitlePreparation)
    private programSubtitles: ProgramSubtitlePreparation,
    @inject(StreamSelectionProfileResolver)
    private profileResolver: StreamSelectionProfileResolver,
    @inject(KEYS.FillerListDB) private fillerListDB: IFillerListDB,
  ) {
    super();
  }

  protected async runInternal(
    request: SubtitleExtractorTaskRequest,
  ): Promise<ProgramSubtitleResult | LookaheadPreparationResult | void> {
    if (request.filter?.type === 'program') {
      const result = await this.programSubtitles.prepare(request.filter, {
        requestMissing: requestMissingSubtitle,
      });
      this.logger.info(
        { result },
        'Single-program subtitle preparation finished',
      );
      return result;
    }
    await SubtitleExtractorTask.extractionMutex.runExclusive(async () => {
      const removed = await sweepSubtitleCache(
        path.join(
          this.globalOptions.databaseDirectory,
          CacheFolderName,
          SubtitlesCacheFolderName,
        ),
        this.drizzleDB,
        this.lineups,
      );
      if (removed)
        this.logger.info(
          'Removed %d unreferenced subtitle cache entries',
          removed,
        );
    });
    const filter = request.filter ?? defaultFilter;
    switch (filter.type) {
      case 'time':
        return this.handleTimeFilter(filter);
      case 'channel':
        this.logger.debug(
          'Subtitle extraction filter type %s not yet implemented',
          filter.type,
        );
        break;
    }
  }

  private async handleTimeFilter(filter: DurationExtractionFilter) {
    const now = dayjs();

    for (const [key, { failedAt }] of SubtitleExtractorTask.failedExtractions) {
      if (now.valueOf() - failedAt >= FailedExtractionRetryMs) {
        SubtitleExtractorTask.failedExtractions.delete(key);
      }
    }

    for (const [
      key,
      { checkedAt },
    ] of SubtitleExtractorTask.acquisitionOutcomes) {
      if (now.valueOf() - checkedAt >= FailedExtractionRetryMs) {
        SubtitleExtractorTask.acquisitionOutcomes.delete(key);
      }
    }

    // On the first run we may have to block if the guide is updating.
    await this.guideService.get();

    if (!(await this.profileResolver.anyProfileMayPickSubtitles())) return;
    const channels = await this.channelDB.getAllChannels();
    const channelById = new Map(
      channels.map((channel) => [channel.uuid, channel]),
    );
    const range = OpenDateTimeRange.create(now, now.add(filter.durationMs));
    if (!range)
      throw new Error('Subtitle lookahead duration must be nonnegative');
    const upcomingGuide = await this.guideService.getChannelGuides(range);
    const mediaSources = await this.mediaSourceDB.getAll();
    const scheduled = new Map<string, ScheduledPreparation>();
    const add = (
      id: string,
      mediaSourceId: string,
      start: number,
      context: PreparationContext,
    ) => {
      const entry = scheduled.get(id) ?? {
        id,
        mediaSourceId,
        start,
        contexts: new Map<string, PreparationContext>(),
      };
      entry.start = Math.min(entry.start, start);
      entry.contexts.set(
        JSON.stringify([
          context.channel.uuid,
          context.customShowId,
          context.fillerListId,
        ]),
        context,
      );
      scheduled.set(id, entry);
    };
    for (const { id: channelId, programs } of upcomingGuide) {
      const channel = channelById.get(channelId);
      if (!channel) continue;
      const content = programs.filter((p) => p.type === 'content');
      if (!content.length) continue;
      const { items } = await this.channelDB.loadLineup(channelId);
      const showsByProgram = new Map<string, Set<string | undefined>>();
      for (const item of items) {
        if (item.type !== 'content') continue;
        const shows = showsByProgram.get(item.id) ?? new Set();
        shows.add(item.customShowId);
        showsByProgram.set(item.id, shows);
      }
      for (const program of content) {
        for (const customShowId of showsByProgram.get(program.id) ?? [
          undefined,
        ]) {
          if (
            await this.profileResolver.mayPickSubtitles({
              channelId,
              programId: program.id,
              customShowId,
            })
          ) {
            add(program.id, program.program.mediaSourceId, program.start, {
              channel,
              customShowId,
            });
          }
        }
      }
    }
    // Filler is picked when the slot airs, so the guide cannot name its programs.
    const guideChannels = upcomingGuide.flatMap(
      ({ id }) => channelById.get(id) ?? [],
    );
    for (const fillerListId of await this.fillerListDB.getAllFillerIds()) {
      if (
        !(await this.profileResolver.fillerListMayPickSubtitles(
          fillerListId,
          guideChannels.map((c) => c.uuid),
        ))
      )
        continue;
      for (const program of await this.fillerListDB.getFillerPrograms(
        fillerListId,
      )) {
        if (!program.mediaSourceId) continue;
        for (const channel of guideChannels) {
          add(
            program.uuid,
            program.mediaSourceId,
            now.valueOf() + filter.durationMs,
            { channel, fillerListId },
          );
        }
      }
    }

    const files = new Map<string, ExtractionFile>();
    const acquisitions = new Map<string, AutomaticPreparation>();
    for (const program of [...scheduled.values()].sort(
      (a, b) => a.start - b.start,
    )) {
      const mediaSource = mediaSources.find(
        (ms) => ms.uuid === program.mediaSourceId,
      );
      if (!mediaSource) continue;
      const result = await Result.attemptAsync(() =>
        this.collectRequiredSubtitles(
          program,
          mediaSource,
          files,
          acquisitions,
        ),
      );
      if (result.isFailure()) {
        this.logger.warn(
          result.error,
          'Failed to prepare subtitles for program %s',
          program.id,
        );
      }
    }
    // Collect every channel's requirements before reading any media file.
    let deferredFiles = 0;
    for (const [key, file] of files) {
      const result = await Result.attemptAsync(() =>
        this.prepareFile(key, file),
      );
      if (result.isFailure())
        this.logger.warn(result.error, 'Failed to prepare subtitle cache');
      else if (!result.get()) deferredFiles++;
    }
    const programs: LookaheadPreparationResult['programs'] = [];
    for (const preparation of [...acquisitions.values()].sort(
      (a, b) => a.earliestAiring - b.earliestAiring,
    )) {
      const result = await this.prepareAutomatically(preparation);
      programs.push({
        programId: preparation.request.programId,
        sdh: preparation.request.sdh,
        result,
      });
    }
    const deferredPrograms = programs.filter(
      ({ result }) => result.status === 'deferred',
    ).length;
    if (deferredFiles > 0 || deferredPrograms > 0) {
      this.logger.info(
        { deferredFiles, deferredPrograms },
        'Subtitle lookahead work deferred; reconsidering on the next run',
      );
    }
    return { programs, deferredExtractions: deferredFiles };
  }

  /**
   * Resolves sidecar subtitles that currently have no file Tunarr can open --
   * because the media source was unreachable when the library was scanned, or
   * because the cached copy has since been deleted. Without this, such a
   * subtitle stays missing until the library happens to be rescanned.
   */
  private async topUpExternalSubtitles(
    dbProgram: ProgramWithRelationsOrm,
    mediaSource: MediaSourceWithRelations,
  ) {
    for (const subtitle of dbProgram.subtitles ?? []) {
      if (subtitle.subtitleType !== 'sidecar') {
        continue;
      }

      if (
        isNonEmptyString(subtitle.path) &&
        (await fileExists(subtitle.path))
      ) {
        continue;
      }

      // Storage shared with the media source is preferred: no download, and no
      // second copy of a file we can already read.
      const sharedPath = await PathCalculator.findLocalPath(
        subtitle.sourcePath,
        mediaSource.replacePaths,
      );
      if (sharedPath) {
        this.logger.debug(
          'Found external subtitle %s for program %s on shared storage: %s',
          subtitle.uuid,
          dbProgram.uuid,
          sharedPath,
        );
        await this.saveResolvedSubtitlePath(subtitle, sharedPath);
        continue;
      }

      const subtitleKey = subtitle.sourceKey;
      if (!isNonEmptyString(subtitleKey)) {
        continue;
      }

      const downloadResult = await Result.attemptAsync(() =>
        this.externalSubtitleDownloader.downloadSubtitlesIfNecessary(
          {
            externalKey: dbProgram.externalKey,
            externalSourceId: mediaSource.uuid,
            sourceType: dbProgram.sourceType,
            uuid: dbProgram.uuid,
          },
          {
            streamIndex: subtitle.streamIndex ?? undefined,
            codec: subtitle.codec,
            // External subtitles have no stream index, so the source-relative
            // location is what keeps their cache entries distinct.
            key: subtitleKey,
          },
          () => this.fetchExternalSubtitle(mediaSource, subtitleKey),
        ),
      );

      if (downloadResult.isFailure()) {
        this.logger.warn(
          downloadResult.error,
          'Error downloading external subtitle %s for program %s',
          subtitle.uuid,
          dbProgram.uuid,
        );
        continue;
      }

      const fullPath = downloadResult.get();
      if (!isNonEmptyString(fullPath)) {
        continue;
      }

      this.logger.debug(
        'Downloaded external subtitle %s for program %s to local cache: %s',
        subtitle.uuid,
        dbProgram.uuid,
        fullPath,
      );
      await this.saveResolvedSubtitlePath(subtitle, fullPath);
    }
  }

  private async saveResolvedSubtitlePath(
    subtitle: ProgramSubtitles,
    path: string,
  ) {
    await this.programDB.setSubtitlePath(subtitle.uuid, path);
    // Keep the in-memory row in step so anything downstream in this run sees
    // the same location that was just persisted.
    subtitle.path = path;
  }

  private async fetchExternalSubtitle(
    mediaSource: MediaSourceWithRelations,
    key: string,
  ): Promise<QueryResult<string>> {
    switch (mediaSource.type) {
      case 'plex': {
        const client =
          await this.mediaSourceApiFactory.getPlexApiClientForMediaSource(
            mediaSource,
          );
        return client.getSubtitles(key);
      }
      case 'jellyfin': {
        const client =
          await this.mediaSourceApiFactory.getJellyfinApiClientForMediaSource(
            mediaSource,
          );
        return client.getSubtitlesByPath(key);
      }
      case 'emby': {
        const client =
          await this.mediaSourceApiFactory.getEmbyApiClientForMediaSource(
            mediaSource,
          );
        return client.getSubtitlesByPath(key);
      }
      case 'local':
        // Local libraries are scanned off storage Tunarr already has open, so
        // their sidecars are never fetched over the network.
        return Result.failure(
          QueryError.create(
            'generic_request_error',
            'Local media sources have no subtitle endpoint',
          ),
        );
    }
  }

  private lookaheadBudget(now: number) {
    const database = path.resolve(this.globalOptions.databaseDirectory);
    let budget = SubtitleExtractorTask.lookaheadBudgets.get(database);
    if (!budget || now - budget.startedAt >= LookaheadBudgetWindowMs) {
      budget = { startedAt: now, spentMs: 0 };
      SubtitleExtractorTask.lookaheadBudgets.set(database, budget);
    }
    return budget;
  }

  private async prepareAutomatically(
    preparation: AutomaticPreparation,
  ): Promise<AutomaticPreparationOutcome> {
    const { request, identity, earliestAiring } = preparation;
    const key = JSON.stringify([
      path.resolve(this.globalOptions.databaseDirectory),
      request.programId,
      identity,
      request.sdh,
    ]);
    // The existing extraction slot also serializes guide-triggered acquisition.
    // Recheck inside it so an overlapping run cannot repeat an unresolved search.
    return SubtitleExtractorTask.extractionMutex.runExclusive(async () => {
      const previous = SubtitleExtractorTask.acquisitionOutcomes.get(key);
      const recent =
        previous && Date.now() - previous.checkedAt < FailedExtractionRetryMs
          ? previous
          : undefined;
      const pending =
        recent?.result.status === 'awaiting-library'
          ? recent.result
          : undefined;
      if (recent && !pending) return recent.result;
      const started = performance.now();
      const budget = this.lookaheadBudget(started);
      // OCR has no urgent bypass: a dense schedule must not admit unlimited OCR.
      if (
        !this.settingsDB.ffmpegSettings().enableAutomaticSubtitlePreparation ||
        budget.spentMs >= LookaheadBudgetMs
      )
        return { status: 'deferred' };
      let result: AutomaticPreparationOutcome;
      try {
        result = await this.programSubtitles.prepare(request, {
          pendingRequest: pending,
          requestMissing: requestMissingSubtitle,
          reuseExistingText: preparation.reuseExistingText,
          acceptText: preparation.acceptText,
        });
      } catch (error) {
        result = {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
        this.logger.warn(
          error,
          'Automatic subtitle preparation failed for program %s',
          request.programId,
        );
      } finally {
        budget.spentMs += performance.now() - started;
      }
      if (
        !['cached', 'prepared', 'existing-text-track'].includes(result.status)
      ) {
        SubtitleExtractorTask.acquisitionOutcomes.set(key, {
          checkedAt:
            result.status === 'awaiting-library' && recent
              ? recent.checkedAt
              : Date.now(),
          result,
        });
      } else if (pending) SubtitleExtractorTask.acquisitionOutcomes.delete(key);
      this.logger.info(
        { programId: request.programId, earliestAiring, result },
        'Automatic subtitle preparation finished',
      );
      return result;
    });
  }

  private async prepareFile(key: string, file: ExtractionFile) {
    // Serialize by file across transient task instances. Recheck the cache and
    // failure cooldown after waiting: another run may need different tracks.
    while (SubtitleExtractorTask.pendingFiles.has(key)) {
      await SubtitleExtractorTask.pendingFiles.get(key);
    }
    const current = SubtitleExtractorTask.extractionMutex.runExclusive(
      async () => {
        const started = performance.now();
        const budget = this.lookaheadBudget(started);
        const urgent = file.earliestAiring <= Date.now() + UrgentLookaheadMs;
        if (!urgent && budget.spentMs >= LookaheadBudgetMs) return false;
        try {
          await this.extractFile(key, file);
          return true;
        } finally {
          // Charge actual work, including urgent files, but not time waiting for the slot.
          // The allowance controls admission only; an active read is never cut short.
          budget.spentMs += performance.now() - started;
        }
      },
    );
    SubtitleExtractorTask.pendingFiles.set(key, current);
    try {
      return await current;
    } finally {
      SubtitleExtractorTask.pendingFiles.delete(key);
    }
  }

  /**
   * What identifies the file an extraction reads, so a failure is retried as
   * soon as the file changes: its path plus size and modification time when it
   * is local, or its URL without the query string (tokens, sessions).
   */
  private static async sourceSignature(source: {
    type: string;
    path: string;
  }): Promise<string> {
    if (source.type !== 'file') {
      return source.path.split('?')[0]!;
    }
    const stats = await fs.stat(source.path).catch(() => undefined);
    return stats
      ? JSON.stringify([source.path, stats.size, stats.mtimeMs])
      : source.path;
  }

  private async collectRequiredSubtitles(
    program: ScheduledPreparation,
    mediaSource: MediaSourceWithRelations,
    files: Map<string, ExtractionFile>,
    acquisitions: Map<string, AutomaticPreparation>,
  ) {
    const dbProgram = await this.prepareProgram(program.id, mediaSource);
    if (!dbProgram) return;
    const settings = this.settingsDB.ffmpegSettings();
    const contexts = [...program.contexts.values()];
    const scheduledContent = contexts.some((ctx) => !ctx.fillerListId);
    const allowAcquisition =
      scheduledContent && settings.enableAutomaticSubtitlePreparation;
    if (
      !scheduledContent &&
      dbProgram.subtitles?.length &&
      !dbProgram.subtitles.some(
        (sub) =>
          sub.subtitleType === 'embedded' &&
          sub.streamIndex !== null &&
          !isImageBasedSubtitle(sub.codec),
      )
    )
      return;
    if (!settings.enableSubtitleExtraction && !allowAcquisition) return;
    // Legacy Direct V2 passes tracks through; Next consumes prepared sidecars.
    const transcodeChannels = contexts.filter(
      ({ channel }) =>
        channel.streamMode !== 'hls_direct_v2' ||
        routesToEtvNext(channel.streamMode, channel.useEtvNext ?? false),
    );
    if (transcodeChannels.length === 0 && !allowAcquisition) return;
    const result = await this.streamDetailsFetcher.getStream({
      server: mediaSource,
      lineupItem: { ...dbProgram, mediaSourceId: mediaSource.uuid },
    });
    if (result.isFailure()) throw result.error;
    const { streamSource, streamDetails } = result.get();
    const { audioDetails, subtitleDetails } = streamDetails;
    const identity = await subtitleSourceIdentity(
      streamSource,
      dbProgram.canonicalId,
    );
    for (const subtitle of subtitleDetails ?? []) {
      if (subtitle.type === 'embedded') subtitle.sourceIdentity = identity;
    }
    const cacheFolder = path.join(
      this.globalOptions.databaseDirectory,
      CacheFolderName,
      SubtitlesCacheFolderName,
    );
    const key = JSON.stringify([
      path.resolve(this.globalOptions.databaseDirectory),
      // Local paths identify the file even if two libraries reference it.
      streamSource.type === 'file' ? '' : mediaSource.uuid,
      streamSource.type === 'http'
        ? streamSource.path.split('?')[0]
        : streamSource.path,
      identity,
    ]);
    const requiredSubtitles = new Set<SubtitleStreamDetails>();
    const prepareAllEnglish =
      allowAcquisition &&
      settings.automaticSubtitlePreparationMode === 'all_english';
    const select = (
      context: PreparationContext,
      tracks: SubtitleStreamDetails[],
    ) =>
      this.streamSelector.selectSubtitleStream({
        channel: context.channel,
        lineupItem: {
          ...(context.fillerListId
            ? {
                type: 'commercial' as const,
                fillerListId: context.fillerListId,
              }
            : { type: 'program' as const, customShowId: context.customShowId }),
          program: { ...dbProgram, mediaSourceId: mediaSource.uuid },
          duration: dbProgram.duration,
          streamDuration: dbProgram.duration,
          programBeginMs: program.start,
          infiniteLoop: false,
        },
        audioStreams: audioDetails,
        subtitleStreams: tracks,
        hints: { allowUnextracted: true },
      });
    const queueAcquisition = (sdh: boolean, reuseExistingText: boolean) => {
      const acquisitionKey = JSON.stringify([program.id, sdh]);
      const existing = acquisitions.get(acquisitionKey);
      acquisitions.set(acquisitionKey, {
        request: { programId: program.id, sdh },
        acceptText: async (candidate) => {
          if (prepareAllEnglish) return true;
          for (const context of contexts) {
            if (context.fillerListId) continue;
            const selected = await select(context, [
              candidate,
              ...(subtitleDetails ?? []),
            ]);
            if (selected === candidate) return true;
          }
          return false;
        },
        identity,
        reuseExistingText:
          reuseExistingText && (existing?.reuseExistingText ?? true),
        earliestAiring: Math.min(
          program.start,
          existing?.earliestAiring ?? program.start,
        ),
      });
    };
    if (prepareAllEnglish) {
      queueAcquisition(false, true);
      const text = findReusableEnglishText(subtitleDetails ?? [], false);
      if (text) requiredSubtitles.add(text);
    }
    const selectionContexts = allowAcquisition ? contexts : transcodeChannels;
    for (const context of selectionContexts) {
      const subtitle = await select(context, subtitleDetails ?? []);
      if (subtitle) requiredSubtitles.add(subtitle);
      if (
        allowAcquisition &&
        !context.fillerListId &&
        !prepareAllEnglish &&
        (!subtitle || isImageBasedSubtitle(subtitle.codec))
      ) {
        let admitted = false;
        for (const { sdh, codec } of [false, true].flatMap((sdh) =>
          ['srt', 'ass'].map((codec) => ({ sdh, codec })),
        )) {
          const candidate: SubtitleStreamDetails = {
            type: 'external',
            codec,
            languageCodeISO6392: 'eng',
            default: false,
            forced: false,
            sdh,
          };
          if (
            (await select(context, [candidate, ...(subtitleDetails ?? [])])) !==
            candidate
          )
            continue;
          // The profile rejected existing text; it must not stop acquisition.
          queueAcquisition(sdh, false);
          admitted = true;
          break;
        }
        if (!admitted && mediaSource.type !== 'local') {
          // Titles are unknown until library lookup. The job checks actual
          // tracks against the profile before importing or starting OCR.
          for (const sdh of [false, true]) queueAcquisition(sdh, false);
        }
      }
    }
    for (const subtitle of requiredSubtitles) {
      if (
        !subtitle ||
        subtitle.type !== 'embedded' ||
        isImageBasedSubtitle(subtitle.codec) ||
        subtitle.index === undefined
      )
        continue;
      const relativePath = getSubtitleCacheFilePath(
        {
          externalKey: dbProgram.externalKey,
          externalSourceId: mediaSource.uuid,
          externalSourceType: dbProgram.sourceType,
          id: dbProgram.uuid,
        },
        { streamIndex: subtitle.index, codec: subtitle.codec, key: identity },
      );
      if (!relativePath) continue;
      const outPath = path.join(cacheFolder, relativePath);
      if (await hasSubtitleCache(outPath, identity)) continue;
      const file = files.get(key) ?? {
        earliestAiring: program.start,
        source: streamSource,
        identity,
        revision: dbProgram.canonicalId,
        progressStream: streamDetails.videoDetails
          ? ('0:v:0' as const)
          : ('0:a:0' as const),
        mediaSourceIds: new Set(),
        outputs: new Map(),
      };
      file.earliestAiring = Math.min(file.earliestAiring, program.start);
      file.mediaSourceIds.add(mediaSource.uuid);
      file.outputs.set(outPath, {
        subtitle,
        outPath,
        programId: dbProgram.uuid,
      });
      files.set(key, file);
    }
  }

  private async prepareProgram(
    id: string,
    mediaSource: MediaSourceWithRelations,
  ) {
    const key = JSON.stringify([
      path.resolve(this.globalOptions.databaseDirectory),
      mediaSource.uuid,
      id,
    ]);
    const pending = SubtitleExtractorTask.pendingPrograms.get(key);
    if (pending) return pending;
    const current = (async () => {
      const program = await this.programDB.getProgramById(id);
      if (program) await this.topUpExternalSubtitles(program, mediaSource);
      return program;
    })();
    SubtitleExtractorTask.pendingPrograms.set(key, current);
    try {
      return await current;
    } finally {
      SubtitleExtractorTask.pendingPrograms.delete(key);
    }
  }

  private async extractFile(key: string, file: ExtractionFile) {
    const source = await SubtitleExtractorTask.sourceSignature(file.source);
    const failed = SubtitleExtractorTask.failedExtractions.get(key);
    if (
      failed?.source === source &&
      Date.now() - failed.failedAt < FailedExtractionRetryMs
    )
      return;
    const tracks = new Map<
      number,
      { subtitle: SubtitleStreamDetails; outPaths: string[]; tmpPath: string }
    >();
    for (const { subtitle, outPath } of file.outputs.values()) {
      if (
        (await hasSubtitleCache(outPath, file.identity)) ||
        subtitle.index === undefined
      )
        continue;
      const track = tracks.get(subtitle.index) ?? {
        subtitle,
        outPaths: [],
        tmpPath: await tmpName({ postfix: extname(outPath) }),
      };
      track.outPaths.push(outPath);
      tracks.set(subtitle.index, track);
    }
    if (tracks.size === 0) return;
    const extractionStarted = performance.now();
    let reducedPath: string | undefined;
    let longestReadPauseSeconds = 0;
    try {
      if (
        (await subtitleSourceIdentity(file.source, file.revision)) !==
        file.identity
      ) {
        throw new Error(
          'Media file changed while subtitle extraction was queued',
        );
      }
      let inputPath = file.source.path;
      let streamIndexes: Map<number, number> | undefined;
      let selectiveRead:
        | { bytesRead: number; sourceSizeBytes: number }
        | undefined;
      if (
        file.source.type === 'file' &&
        ['.mkv', '.mks', '.webm'].includes(extname(inputPath).toLowerCase())
      ) {
        reducedPath = await tmpName({ postfix: '.mks' });
        const abort = new AbortController();
        let lastReadBytes = 0;
        let lastReadAt = performance.now();
        const watchdog = setTimeout(
          () =>
            abort.abort(
              new Error(
                'Subtitle extraction made no container progress for 60 seconds',
              ),
            ),
          60_000,
        );
        try {
          const reduced = await createSubtitleMatroska(
            inputPath,
            reducedPath,
            [...tracks.keys()],
            {
              signal: abort.signal,
              onProgress: (_position, bytesRead) => {
                if (bytesRead > lastReadBytes) {
                  const now = performance.now();
                  longestReadPauseSeconds = Math.max(
                    longestReadPauseSeconds,
                    (now - lastReadAt) / 1000,
                  );
                  lastReadAt = now;
                  lastReadBytes = bytesRead;
                  watchdog.refresh();
                }
              },
            },
          );
          selectiveRead = {
            bytesRead: reduced.bytesRead,
            sourceSizeBytes: reduced.sourceSizeBytes,
          };
          streamIndexes = reduced.streamIndexes;
          inputPath = reducedPath;
          this.logger.info(
            {
              bytesRead: reduced.bytesRead,
              sourceSizeBytes: reduced.sourceSizeBytes,
              tracks: tracks.size,
            },
            'Selective Matroska subtitle read completed',
          );
        } catch (error) {
          if (!(error instanceof UnsupportedMatroskaError)) throw error;
          this.logger.info(
            { reason: error.message },
            'Using FFmpeg subtitle extraction for unsupported Matroska structure',
          );
        } finally {
          clearTimeout(watchdog);
        }
      }
      const args = [
        ...(file.source.type === 'http'
          ? new HttpReconnectOptions().options()
          : []),
        '-i',
        inputPath,
        // First output owns -progress total_size. Copy media packets to the
        // OS null device: unlike the null muxer, data reports bytes written.
        // No decoding, and sparse subtitle output cannot stall this clock.
        ...(streamIndexes
          ? []
          : ['-map', file.progressStream, '-c', 'copy', '-f', 'data', devNull]),
      ];
      for (const [index, { subtitle, tmpPath }] of tracks) {
        const inputIndex = streamIndexes ? streamIndexes.get(index) : index;
        if (inputIndex === undefined)
          throw new Error('Selected subtitle missing from reduced Matroska');
        args.push(
          '-map',
          `0:${inputIndex}`,
          '-c:s',
          subtitle.codec === 'mov_text' ? 'text' : 'copy',
          tmpPath,
        );
      }
      const started = performance.now();
      const sample = await new SubtitleExtractionProcess().run(
        this.settingsDB.ffmpegSettings().ffmpegExecutablePath,
        args,
      );
      if (selectiveRead) {
        const conversionBytesRead = sample.bytesRead;
        sample.longestProgressPauseSeconds = Math.max(
          sample.longestProgressPauseSeconds,
          longestReadPauseSeconds,
        );
        sample.elapsedSeconds = (performance.now() - extractionStarted) / 1000;
        sample.bytesRead = selectiveRead.bytesRead + conversionBytesRead;
        sample.secondsPerGB =
          sample.bytesRead > 0
            ? sample.elapsedSeconds / (sample.bytesRead / 1e9)
            : null;
        this.logger.info(
          {
            ...selectiveRead,
            conversionBytesRead,
            conversionSeconds: (performance.now() - started) / 1000,
          },
          'Subtitle preparation input accounting',
        );
      }
      if (
        (await subtitleSourceIdentity(file.source, file.revision)) !==
        file.identity
      ) {
        throw new Error('Media file changed during subtitle extraction');
      }
      for (const { outPaths, tmpPath } of tracks.values()) {
        for (const outPath of outPaths) {
          await fs.mkdir(dirname(outPath), { recursive: true });
          // Publish the complete subtitle before marking this source identity usable.
          const stagingPath = await tmpName({
            tmpdir: dirname(outPath),
            postfix: extname(outPath),
          });
          try {
            await pipeline(
              createReadStream(tmpPath),
              new Transform({
                transform(chunk: Buffer, _encoding, cb) {
                  cb(
                    null,
                    chunk.filter((byte) => byte !== 0x00),
                  );
                },
              }),
              createWriteStream(stagingPath),
            );
            await fs.rename(stagingPath, outPath);
            const output = file.outputs.get(outPath);
            if (!output) throw new Error('Missing subtitle cache owner');
            await recordSubtitleCache(outPath, output.programId, file.identity);
          } finally {
            await fs.rm(stagingPath, { force: true });
          }
        }
      }
      for (const programId of new Set(
        [...file.outputs.values()].map((output) => output.programId),
      )) {
        await retireReplacedSubtitleCache(
          path.join(
            this.globalOptions.databaseDirectory,
            CacheFolderName,
            SubtitlesCacheFolderName,
          ),
          programId,
          file.identity,
        );
      }
      SubtitleExtractorTask.failedExtractions.delete(key);
      for (const mediaSourceId of file.mediaSourceIds) {
        this.logger.info(
          { mediaSourceId, tracks: tracks.size, ...sample },
          'Subtitle extraction completed',
        );
      }
    } catch (error) {
      SubtitleExtractorTask.failedExtractions.set(key, {
        source,
        failedAt: Date.now(),
      });
      this.logger.warn(
        error,
        'Failed to extract subtitles; not retrying this file for %d hours unless it changes',
        FailedExtractionRetryMs / 3_600_000,
      );
    } finally {
      if (reducedPath) await fs.rm(reducedPath, { force: true });
      await Promise.all(
        [...tracks.values()].map(({ tmpPath }) =>
          fs.rm(tmpPath, { force: true }),
        ),
      );
    }
  }
}
