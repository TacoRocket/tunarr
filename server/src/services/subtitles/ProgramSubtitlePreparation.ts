import { inject, injectable } from 'inversify';
import z from 'zod';
import type { IProgramDB } from '../../db/interfaces/IProgramDB.ts';
import { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import { MediaSourceApiFactory } from '../../external/MediaSourceApiFactory.ts';
import { PgsSubtitleCodecs } from '../../ffmpeg/builder/MediaStream.ts';
import type { IWorkerPool } from '../../interfaces/IWorkerPool.ts';
import { ProgramStreamDetailsFetcher } from '../../stream/ProgramStreamDetailsFetcher.ts';
import type { SubtitleStreamDetails } from '../../stream/types.ts';
import { KEYS } from '../../types/inject.ts';
import { FileSystemService } from '../FileSystemService.ts';
import { acquiredSubtitles, subtitleSourceIdentity } from './SubtitleCache.ts';
import {
  searchPlexSubtitles,
  type PlexSubtitleCandidate,
} from './PlexSubtitleAcquisition.ts';
import { PlexSubtitleCache } from './PlexSubtitleCache.ts';

export const ProgramSubtitleRequest = z.object({
  programId: z.string(),
  sdh: z.boolean().default(false),
  plexCandidateId: z.string().optional(),
  ocrStreamIndex: z.number().int().nonnegative().optional(),
});
export type ProgramSubtitleRequest = z.infer<typeof ProgramSubtitleRequest>;
export type ProgramSubtitleResult = Awaited<
  ReturnType<ProgramSubtitlePreparation['prepare']>
>;

export function findReusableEnglishText(
  subtitles: readonly SubtitleStreamDetails[],
  sdh: boolean,
) {
  return subtitles.find(
    (subtitle) =>
      ['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(
        subtitle.codec,
      ) &&
      subtitle.languageCodeISO6392 === 'eng' &&
      subtitle.sdh === sdh &&
      !subtitle.forced,
  );
}

@injectable()
export class ProgramSubtitlePreparation {
  constructor(
    @inject(KEYS.ProgramDB) private programs: IProgramDB,
    @inject(MediaSourceDB) private sources: MediaSourceDB,
    @inject(ProgramStreamDetailsFetcher)
    private streams: ProgramStreamDetailsFetcher,
    @inject(FileSystemService) private files: FileSystemService,
    @inject(MediaSourceApiFactory) private clients: MediaSourceApiFactory,
    @inject(PlexSubtitleCache) private plexCache: PlexSubtitleCache,
    @inject(KEYS.WorkerPool) private workers: IWorkerPool,
  ) {}

  async prepare(
    request: ProgramSubtitleRequest,
    options: { reuseExistingText?: boolean } = {},
  ) {
    const program = await this.programs.getProgramById(request.programId);
    if (!program || program.state !== 'ok' || !program.mediaSourceId)
      throw new Error(
        'Program must be present in the library and outside Trash',
      );
    const server = await this.sources.getById(program.mediaSourceId);
    if (!server) throw new Error('Program has no configured media source');
    const fetched = await this.streams.getStream({
      server,
      lineupItem: { ...program, mediaSourceId: program.mediaSourceId },
    });
    if (fetched.isFailure()) throw fetched.error;
    const { streamSource, streamDetails } = fetched.get();
    const folder = this.files.getSubtitleCacheFolder();
    const identity = await subtitleSourceIdentity(
      streamSource,
      program.canonicalId,
    );
    const cached = (
      await acquiredSubtitles(folder, program.uuid, identity)
    ).find((s) => s.language === 'eng' && s.sdh === request.sdh && !s.forced);
    if (cached)
      return {
        status: 'cached' as const,
        provider: cached.provider,
        path: cached.path,
      };

    const subtitles = streamDetails.subtitleDetails ?? [];
    const text = findReusableEnglishText(subtitles, request.sdh);
    if (text && options.reuseExistingText !== false)
      return {
        status: 'existing-text-track' as const,
        codec: text.codec,
        path: text.path,
        streamIndex: text.index,
      };

    if (server.type === 'plex') {
      const client = await this.clients.getPlexApiClientForMediaSource(server);
      // A provider failure is not an empty search and must not silently start OCR.
      let candidates: PlexSubtitleCandidate[];
      try {
        candidates = await searchPlexSubtitles(
          client,
          program.externalKey,
          request.sdh,
        );
      } catch (cause) {
        throw new Error('Plex subtitle search failed; OCR was not started', {
          cause,
        });
      }
      const matches =
        request.plexCandidateId === undefined
          ? candidates
          : candidates.filter((s) => s.id === request.plexCandidateId);
      if (request.plexCandidateId !== undefined || candidates.length > 0) {
        const candidate = matches[0];
        if (matches.length !== 1 || !candidate)
          return {
            status: 'needs-selection' as const,
            provider: 'plex' as const,
            candidates: candidates.map((s) => ({
              id: s.id,
              title: s.title,
              sdh: s.hearingImpaired,
            })),
          };
        const output = await this.plexCache.prepare({
          program,
          server,
          streamSource,
          identity,
          candidate,
          sdh: request.sdh,
        });
        return {
          status: 'prepared' as const,
          provider: 'plex' as const,
          path: output,
        };
      }
    } else if (request.plexCandidateId !== undefined) {
      throw new Error('Plex selection requires a configured Plex source');
    }

    const pgs = subtitles.filter(
      (s) =>
        s.type === 'embedded' &&
        PgsSubtitleCodecs.includes(s.codec) &&
        s.languageCodeISO6392 === 'eng' &&
        !s.forced &&
        s.index !== undefined,
    );
    // Embedded SDH metadata is not reliable yet. An explicit stream selection
    // is the operator's declaration of the requested SDH classification.
    const matches = pgs.filter((s) =>
      request.ocrStreamIndex === undefined
        ? s.sdh === request.sdh
        : s.index === request.ocrStreamIndex,
    );
    const track = matches[0];
    if (matches.length !== 1 || !track || track.index === undefined) {
      return {
        status:
          pgs.length > 0
            ? ('needs-selection' as const)
            : ('unavailable' as const),
        provider: 'pgs-ocr' as const,
        candidates: pgs.map((s) => ({
          streamIndex: s.index,
          title: s.title,
          sdh: s.sdh,
        })),
      };
    }
    if (process.platform !== 'linux' || streamSource.type !== 'file')
      return {
        status: 'unsupported' as const,
        provider: 'pgs-ocr' as const,
        reason: 'OCR requires Linux and a locally accessible Matroska file',
      };
    await this.workers.allReady();
    const reply = await this.workers.queueTask(
      {
        type: 'pgs-ocr',
        request: {
          programId: program.uuid,
          inputPath: streamSource.path,
          revision: program.canonicalId,
          streamIndex: track.index,
          forced: false,
          sdh: request.sdh,
          cacheFolder: folder,
        },
      },
      30 * 60_000,
    );
    return { ...reply.result, provider: 'pgs-ocr' as const };
  }
}
