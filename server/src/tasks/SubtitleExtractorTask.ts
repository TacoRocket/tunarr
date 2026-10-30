import { seq } from '@tunarr/shared/util';
import type { ContentGuideProgram } from '@tunarr/types';
import { tag } from '@tunarr/types';
import dayjs from 'dayjs';
import { inject, injectable } from 'inversify';
import { isUndefined } from 'lodash-es';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path, { dirname, extname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpName } from 'tmp-promise';
import z from 'zod';
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
import { ChildProcessHelper } from '../util/ChildProcessHelper.ts';
import {
  CacheFolderName,
  SubtitlesCacheFolderName,
} from '../util/constants.ts';
import { fileExists } from '../util/fsUtil.ts';
import { isDefined, isNonEmptyString } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { getSubtitleCacheFilePath } from '../util/subtitles.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';

const ChannelExtractionFilter = z.object({
  type: z.literal('channel'),
  channelId: z.string(),
});

const ProgramExtractionFilter = z.object({
  type: z.literal('program'),
  programId: z.string(),
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
  durationMs: dayjs.duration({ hours: 1 }).asMilliseconds(),
} satisfies DurationExtractionFilter;

// After an extraction fails, its file isn't read again for this long unless it
// changes. Hourly runs and guide rebuilds otherwise retry a file that can't
// finish over and over, each time reading it end to end (#81).
const FailedExtractionRetryMs = dayjs.duration({ hours: 6 }).asMilliseconds();

@injectable()
@taskDef({
  name: SubtitleExtractorTask.name,
  description:
    'Extracts embedded, text-based subtitles from scheduled programs and downloads any external subtitles that are still missing',
  schema: SubtitleExtractorTaskRequest,
})
export class SubtitleExtractorTask extends Task2<
  typeof SubtitleExtractorTaskRequest
> {
  static KEY = SubtitleExtractorTask.name;
  static ID = SubtitleExtractorTask.name;
  private static pendingPrograms = new Map<string, Promise<void>>();
  // Programs whose last extraction failed: the file it read and when. At most
  // one entry per program that failed within FailedExtractionRetryMs; expired
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
  ) {
    super();
  }

  protected async runInternal(
    request: SubtitleExtractorTaskRequest,
  ): Promise<void> {
    const filter = request.filter ?? defaultFilter;
    switch (filter.type) {
      case 'time':
        await this.handleTimeFilter(filter);
        break;
      case 'channel':
      case 'program':
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

    // On the first run we may have to block if the guide is updating.
    await this.guideService.get();

    const channelIds = (await this.channelDB.getAllChannels())
      .filter((channel) => channel.subtitlesEnabled)
      .map((channel) => channel.uuid);

    if (channelIds.length === 0) {
      this.logger.trace(
        'Skipping subtitle extraction because no channel has subtitles enabled',
      );
      return;
    }

    const nextHourGuide = await this.guideService.getChannelGuides(
      OpenDateTimeRange.create(now, now.add(filter.durationMs))!,
      channelIds,
    );
    const mediaSources = await this.mediaSourceDB.getAll();

    for (const { programs } of nextHourGuide) {
      for (const program of programs) {
        if (program.type !== 'content') {
          continue;
        }

        const mediaSource = mediaSources.find(
          (ms) => ms.uuid === program.program.mediaSourceId,
        );
        if (!mediaSource) {
          // log
          continue;
        }

        const result = await Result.attemptAsync(() =>
          this.prepareProgram(program, mediaSource),
        );
        if (result.isFailure()) {
          this.logger.warn(
            result.error,
            'Failed to extract subtitles for program %s',
            program.id,
          );
        }
      }
    }
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

  private async prepareProgram(
    program: ContentGuideProgram,
    mediaSource: MediaSourceWithRelations,
  ) {
    const key = JSON.stringify([
      path.resolve(this.globalOptions.databaseDirectory),
      mediaSource.uuid,
      program.id,
    ]);
    // Task instances are transient, so this is shared across them. A request
    // for a program that's already being prepared joins that attempt rather
    // than queueing another: queued requests reran a failing extraction back
    // to back, each one reading the whole file (#81).
    const pending = SubtitleExtractorTask.pendingPrograms.get(key);
    if (pending) {
      return pending;
    }
    const current = this.handleProgram(program, mediaSource, key);
    SubtitleExtractorTask.pendingPrograms.set(key, current);
    try {
      await current;
    } finally {
      if (SubtitleExtractorTask.pendingPrograms.get(key) === current) {
        SubtitleExtractorTask.pendingPrograms.delete(key);
      }
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

  private async handleProgram(
    program: ContentGuideProgram,
    mediaSource: MediaSourceWithRelations,
    key: string,
  ) {
    const dbProgram = await this.programDB.getProgramById(program.id);
    if (!dbProgram) {
      return;
    }

    // External subtitles are files we fetch, not streams we extract, so they
    // are topped up regardless of the extraction setting below.
    await this.topUpExternalSubtitles(dbProgram, mediaSource);

    if (!this.settingsDB.ffmpegSettings().enableSubtitleExtraction) {
      this.logger.trace(
        'Subtitle extraction is not enabled, skipping extraction for program %s',
        program.id,
      );
      return;
    }

    const stream = await this.streamDetailsFetcher.getStream({
      server: mediaSource,
      lineupItem: { ...dbProgram, mediaSourceId: mediaSource.uuid },
    });

    if (stream.isFailure()) {
      this.logger.error(stream.error);
      return;
    }

    const textBasedSubs =
      stream.get().streamDetails.subtitleDetails?.filter((subtitle) => {
        return (
          subtitle.type === 'embedded' && !isImageBasedSubtitle(subtitle.codec)
        );
      }) ?? [];

    const ffmpegSetting = this.settingsDB.ffmpegSettings();

    if (textBasedSubs.length === 0) {
      this.logger.debug('No text-based subtitles for ID: %s', program.id);
      return;
    }

    const cacheFolder = path.join(
      this.globalOptions.databaseDirectory,
      CacheFolderName,
      SubtitlesCacheFolderName,
    );

    // This should've been created on startup but double-check
    if (!(await fileExists(cacheFolder))) {
      await fs.mkdir(cacheFolder);
    }

    const subtitlesToSave = (
      await Promise.all(
        seq.collect(textBasedSubs, async (subtitle) => {
          if (isUndefined(subtitle.index)) {
            return;
          }

          const filePath = getSubtitleCacheFilePath(
            {
              externalKey: program.program.externalId,
              externalSourceId: tag(program.program.mediaSourceId),
              externalSourceType: program.program.sourceType,
              id: program.id,
            },
            { streamIndex: subtitle.index, codec: subtitle.codec },
          );
          if (!filePath) {
            return;
          }

          const fullPath = path.join(cacheFolder, filePath);

          if (!(await fileExists(fullPath))) {
            return {
              subtitle,
              outPath: fullPath,
              tmpPath: await tmpName({ postfix: extname(filePath) }),
            };
          }
          this.logger.trace(
            'Skipping existing subtitle extraction (stream index = %d) path for program %s (%s). File already exists: %s',
            subtitle.index,
            program.id,
            program.program.title,
            fullPath,
          );
          return;
        }),
      )
    ).filter(isDefined);

    for (const { outPath } of subtitlesToSave) {
      const outDir = dirname(outPath);
      if (!(await fileExists(outDir))) {
        await fs.mkdir(outDir, { recursive: true });
      }
    }

    const subtitleOutputArgs = subtitlesToSave.reduce((prev, curr) => {
      const codec = curr.subtitle.codec === 'mov_text' ? 'text' : 'copy';
      prev.push(
        '-map',
        `0:${curr.subtitle.index}`,
        '-c:s',
        codec,
        `${curr.tmpPath}`,
      );
      return prev;
    }, [] as string[]);

    if (subtitlesToSave.length === 0) {
      this.logger.trace(
        'No subtitles to extract for program ID = %s',
        program.id,
      );
      return;
    }

    const source = await SubtitleExtractorTask.sourceSignature(
      stream.get().streamSource,
    );
    // Expired entries are dropped at the start of every run, so an entry here
    // means the same file failed within FailedExtractionRetryMs.
    const failed = SubtitleExtractorTask.failedExtractions.get(key);
    if (failed?.source === source) {
      this.logger.debug(
        'Skipping subtitle extraction for program %s: it failed at %s and its file has not changed',
        program.id,
        new Date(failed.failedAt).toISOString(),
      );
      return;
    }

    const outputResult = await Result.attemptAsync(async () => {
      return await new ChildProcessHelper().getStdout(
        ffmpegSetting.ffmpegExecutablePath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'warning',
          ...(stream.get().streamSource.type === 'http'
            ? new HttpReconnectOptions().options()
            : []),
          '-i',
          `${stream.get().streamSource.path}`,
          ...subtitleOutputArgs,
        ],
        {
          swallowError: false,
          isPath: true,
          timeout: 500_000,
        },
      );
    });

    if (outputResult.isFailure()) {
      SubtitleExtractorTask.failedExtractions.set(key, {
        source,
        failedAt: Date.now(),
      });
      this.logger.warn(
        outputResult.error,
        'Failed to extract subtitles; not retrying this file for %d hours unless it changes',
        FailedExtractionRetryMs / 3_600_000,
      );
      return;
    }
    SubtitleExtractorTask.failedExtractions.delete(key);

    const copyResults = await Promise.allSettled(
      subtitlesToSave.map(async ({ outPath, tmpPath }) => {
        // Stream through a Transform that drops stray NUL bytes that some
        // sources (notably mov_text -> ass and certain Plex muxers) embed
        // inside the extracted text. libass refuses to parse a file that
        // contains a NUL, which manifests as missing burn-in subtitles
        // with no obvious ffmpeg-level error.
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
          createWriteStream(outPath),
        );
      }),
    );

    for (const result of copyResults) {
      if (result.status === 'rejected') {
        this.logger.warn(result.reason, 'Failed to copy tmp subtitles');
      }
    }
  }
}
