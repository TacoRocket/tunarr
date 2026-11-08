import type { MediaChapter } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import type { MediaSourceWithRelations } from '../db/schema/derivedTypes.ts';
import { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import { globalOptions } from '../globals.ts';
import { findRepeatedEnding } from '../stream/etv/RepeatedEndingChapter.ts';
import type { ProgramStreamResult } from '../stream/types.ts';
import { KEYS } from '../types/inject.ts';
import { writeFileAtomic } from '../util/fsUtil.ts';
import { isNodeError } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import {
  episodeEndingChapter,
  finalCreditsStart,
} from '../util/programChapterUtil.ts';
import { subtitleSourceIdentity } from './subtitles/SubtitleCache.ts';

type EpisodeRef = Pick<
  StreamLineupProgram,
  'mediaSourceId' | 'externalKey' | 'canonicalId'
>;
const Outcome = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    kind: z.enum(['chapter', 'final']),
    startTime: z.number().positive(),
    endTime: z.number().positive(),
  }),
  z.object({ status: z.literal('waiting'), requestedAt: z.number() }),
  z.object({ status: z.literal('no-ending') }),
]);
const RecordSchema = z.object({ revision: z.string(), outcome: Outcome });
const ScanReadbackLimitMs = 24 * 60 * 60 * 1000;

function recordPath(program: EpisodeRef) {
  const key = createHash('sha256')
    .update(JSON.stringify([program.mediaSourceId, program.externalKey]))
    .digest('hex');
  return path.join(
    globalOptions().databaseDirectory,
    'episode-endings',
    key + '.json',
  );
}

async function readRecord(file: string) {
  try {
    return RecordSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

async function sourceRevision(program: EpisodeRef, media: ProgramStreamResult) {
  const identity = await subtitleSourceIdentity(
    media.streamSource,
    program.canonicalId,
  );
  return JSON.stringify([identity, program.canonicalId]);
}

export async function readPreparedEnding(
  program: EpisodeRef,
  media: ProgramStreamResult,
): Promise<MediaChapter | undefined> {
  const record = await readRecord(recordPath(program));
  if (
    record?.outcome.status !== 'ready' ||
    record.revision !== (await sourceRevision(program, media))
  )
    return;
  const { kind, startTime, endTime } = record.outcome;
  return {
    chapterType: kind === 'final' ? 'outro' : 'chapter',
    isFinal: kind === 'final',
    startTime,
    endTime,
    index: 0,
  };
}

// Reserve before PUT. A crash or a lost reply may leave the request's delivery
// unknown; subsequent runs can read Plex but must never submit it a second time.
async function reserveScan(file: string) {
  try {
    await fs.writeFile(file, '', { flag: 'wx' });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

@injectable()
export class EpisodeEndingPreparation {
  @InjectLogger() declare private readonly logger: Logger;
  constructor(
    @inject(KEYS.SettingsDB) private settings: ISettingsDB,
    @inject(MediaSourceApiFactory) private clients: MediaSourceApiFactory,
  ) {}

  async prepare(
    program: StreamLineupProgram,
    server: MediaSourceWithRelations,
    media: ProgramStreamResult,
    getPeer: () => Promise<ProgramStreamResult | undefined>,
  ) {
    const { streamDetails, streamSource } = media;
    const chapters = streamDetails.chapters ?? [];
    const duration = Math.min(
      program.duration,
      streamDetails.duration.asMilliseconds(),
    );
    if (
      program.type !== 'episode' ||
      !streamDetails.videoDetails ||
      episodeEndingChapter(chapters, duration)
    )
      return;

    const file = recordPath(program);
    const revision = await sourceRevision(program, media);
    const record = await readRecord(file);
    const prior = record?.revision === revision ? record.outcome : undefined;
    if (prior && prior.status !== 'waiting') return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const save = (outcome: z.infer<typeof Outcome>) =>
      writeFileAtomic(file, JSON.stringify({ revision, outcome }));

    if (
      !prior &&
      streamSource.type === 'file' &&
      chapters.some(
        (c) => c.chapterType === 'chapter' && c.startTime >= duration * 0.8,
      )
    ) {
      try {
        const peer = await getPeer();
        if (peer?.streamSource.type === 'file') {
          const match = await findRepeatedEnding(
            this.settings.ffmpegSettings().ffmpegExecutablePath,
            { path: streamSource.path, duration, chapters },
            {
              path: peer.streamSource.path,
              duration: peer.streamDetails.duration.asMilliseconds(),
              chapters: peer.streamDetails.chapters ?? [],
            },
          );
          if (match) {
            const { startTime, endTime } = match[0];
            return save({
              status: 'ready',
              kind: 'chapter',
              startTime,
              endTime,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          error,
          'Could not sample ending chapters for %s',
          program.uuid,
        );
      }
    }

    const importedFinal = finalCreditsStart(chapters, duration);
    if (importedFinal !== undefined)
      return save({
        status: 'ready',
        kind: 'final',
        startTime: importedFinal,
        endTime: duration,
      });
    if (server.type !== 'plex') return save({ status: 'no-ending' });
    const client = await this.clients.getPlexApiClientForMediaSource(server);
    const episode = (
      await client.getItemMetadataRaw(program.externalKey)
    ).getOrThrow();
    if (episode.type !== 'episode' || episode.ratingKey !== program.externalKey)
      throw new Error('Plex returned a different episode');
    const credits = (episode.Marker ?? [])
      .filter((m) => m.type === 'credits')
      .map((m) => ({
        chapterType: 'outro' as const,
        isFinal: m.final,
        startTime: m.startTimeOffset,
        endTime: m.endTimeOffset,
      }));
    const start = finalCreditsStart(credits, duration);
    if (start !== undefined)
      return save({
        status: 'ready',
        kind: 'final',
        startTime: start,
        endTime: duration,
      });
    if (credits.length) return save({ status: 'no-ending' });

    const claim = file + '.plex-requested';
    if (!prior && (await reserveScan(claim))) {
      await save({ status: 'waiting', requestedAt: Date.now() });
      await client.requestEpisodeCreditScan(program.externalKey);
      return;
    }
    const requestedAt = prior?.requestedAt ?? (await fs.stat(claim)).mtimeMs;
    return save(
      Date.now() - requestedAt >= ScanReadbackLimitMs
        ? { status: 'no-ending' }
        : { status: 'waiting', requestedAt },
    );
  }
}
