import type { MediaChapter } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
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
  z.object({ status: z.literal('no-ending') }),
]);
const RecordSchema = z.object({
  programRevision: z.string(),
  revision: z.string(),
  localPath: z.string().nullable(),
  outcome: Outcome,
});

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
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    // Earlier preparation records have no library revision and must be rebuilt.
    if (raw && typeof raw === 'object' && !('programRevision' in raw)) return;
    return RecordSchema.parse(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function programRevision(program: StreamLineupProgram) {
  return JSON.stringify([
    program.canonicalId,
    program.updatedAt,
    program.duration,
    program.filePath,
    program.plexFilePath,
  ]);
}

export async function readPreparedEnding(
  program: StreamLineupProgram,
  media: ProgramStreamResult,
): Promise<MediaChapter | undefined> {
  const record = await readRecord(recordPath(program));
  if (
    record?.outcome.status !== 'ready' ||
    record.programRevision !== programRevision(program) ||
    record.revision !==
      (await subtitleSourceIdentity(media.streamSource, program.canonicalId))
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

@injectable()
export class EpisodeEndingPreparation {
  @InjectLogger() declare private readonly logger: Logger;
  constructor(@inject(KEYS.SettingsDB) private settings: ISettingsDB) {}

  async prepare(
    program: StreamLineupProgram,
    getMedia: () => Promise<ProgramStreamResult | undefined>,
    getPeer: () => Promise<ProgramStreamResult | undefined>,
  ) {
    if (program.type !== 'episode') return;
    const file = recordPath(program);
    const libraryRevision = programRevision(program);
    const record = await readRecord(file);
    if (record?.programRevision === libraryRevision) {
      if (record.localPath === null) return;
      try {
        const identity = await subtitleSourceIdentity({
          type: 'file',
          path: record.localPath,
        });
        if (identity === record.revision) return;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
    }
    const media = await getMedia();
    if (!media) return;
    const { streamDetails, streamSource } = media;
    const chapters = streamDetails.chapters ?? [];
    const duration = Math.min(
      program.duration,
      streamDetails.duration.asMilliseconds(),
    );
    const revision = await subtitleSourceIdentity(
      streamSource,
      program.canonicalId,
    );
    const localPath = streamSource.type === 'file' ? streamSource.path : null;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const save = (outcome: z.infer<typeof Outcome>) =>
      writeFileAtomic(
        file,
        JSON.stringify({
          programRevision: libraryRevision,
          revision,
          localPath,
          outcome,
        }),
      );

    if (!streamDetails.videoDetails) return save({ status: 'no-ending' });
    const named = episodeEndingChapter(chapters, duration);
    if (named)
      return save({
        status: 'ready',
        kind: 'chapter',
        startTime: named.startTime,
        endTime: named.endTime,
      });

    if (
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
    return save({ status: 'no-ending' });
  }
}
