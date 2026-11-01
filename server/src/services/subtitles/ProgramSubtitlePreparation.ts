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
  plexLibrarySubtitles,
  type PlexLibrarySubtitle,
} from './PlexSubtitleAcquisition.ts';
import { PlexSubtitleCache } from './PlexSubtitleCache.ts';
import { MediaServerSubtitleCache } from './MediaServerSubtitleCache.ts';

export const ProgramSubtitleRequest = z.object({
  programId: z.string(),
  sdh: z.boolean().default(false),
  // Online search IDs must not be interpreted as attached library stream IDs.
  plexCandidateId: z.never().optional(),
  plexStreamId: z.string().optional(),
  libraryStreamId: z.string().optional(),
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
    @inject(MediaServerSubtitleCache)
    private mediaServerCache: MediaServerSubtitleCache,
  ) {}

  async prepare(
    request: ProgramSubtitleRequest,
    options: {
      reuseExistingText?: boolean;
      acceptText?: (subtitle: SubtitleStreamDetails) => Promise<boolean>;
    } = {},
  ) {
    const program = await this.programs.getProgramById(request.programId);
    if (!program || program.state !== 'ok' || !program.mediaSourceId)
      throw new Error(
        'Program must be present in the library and outside Trash',
      );
    const server = await this.sources.getById(program.mediaSourceId);
    if (!server) throw new Error('Program has no configured media source');
    if (
      request.libraryStreamId !== undefined &&
      server.type !== 'jellyfin' &&
      server.type !== 'emby'
    )
      throw new Error(
        'Library selection requires a configured Jellyfin or Emby source',
      );
    if (request.plexStreamId !== undefined && server.type !== 'plex')
      throw new Error('Plex selection requires a configured Plex source');
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
    for (const cached of await acquiredSubtitles(
      folder,
      program.uuid,
      identity,
    )) {
      if (
        request.libraryStreamId !== undefined ||
        request.plexStreamId !== undefined
      )
        break;
      if (
        cached.language !== 'eng' ||
        cached.sdh !== request.sdh ||
        cached.forced
      )
        continue;
      if (
        options.acceptText &&
        !(await options.acceptText({
          type: 'external',
          codec: cached.codec,
          path: cached.path,
          title: cached.provider !== 'pgs-ocr' ? cached.title : undefined,
          languageCodeISO6392: cached.language,
          sdh: cached.sdh,
          forced: cached.forced,
          default: false,
        }))
      )
        continue;
      return {
        status: 'cached' as const,
        provider: cached.provider,
        path: cached.path,
      };
    }

    const subtitles = streamDetails.subtitleDetails ?? [];
    const text = findReusableEnglishText(subtitles, request.sdh);
    if (
      text &&
      options.reuseExistingText !== false &&
      (server.type === 'local' || text.type === 'embedded') &&
      request.plexStreamId === undefined &&
      request.libraryStreamId === undefined &&
      (!options.acceptText || (await options.acceptText(text)))
    )
      return {
        status: 'existing-text-track' as const,
        codec: text.codec,
        path: text.path,
        streamIndex: text.index,
      };

    if (server.type === 'plex') {
      const client = await this.clients.getPlexApiClientForMediaSource(server);
      // A provider failure is not an empty library and must not silently start OCR.
      let candidates: PlexLibrarySubtitle[];
      try {
        candidates = await plexLibrarySubtitles(
          client,
          program.externalKey,
          request.sdh,
        );
      } catch (cause) {
        throw new Error(
          'Plex library subtitle lookup failed; OCR was not started',
          {
            cause,
          },
        );
      }
      if (options.acceptText) {
        const accepted: PlexLibrarySubtitle[] = [];
        for (const candidate of candidates) {
          if (
            await options.acceptText({
              type: 'external',
              codec: candidate.codec,
              title: candidate.title,
              languageCodeISO6392: 'eng',
              sdh: candidate.hearingImpaired,
              forced: candidate.forced,
              default: false,
            })
          )
            accepted.push(candidate);
        }
        candidates = accepted;
      }
      const matches =
        request.plexStreamId === undefined
          ? candidates
          : candidates.filter((s) => s.id === request.plexStreamId);
      if (request.plexStreamId !== undefined || candidates.length > 0) {
        const candidate = matches[0];
        if (matches.length !== 1 || !candidate)
          return {
            status: 'needs-selection' as const,
            provider: 'plex' as const,
            candidates: candidates.map((s) => ({
              id: s.id,
              title: s.title,
              sdh: s.hearingImpaired,
              codec: s.codec,
            })),
          };
        const output = await this.plexCache.prepare({
          program,
          server,
          streamSource,
          identity,
          candidate,
          sdh: request.sdh,
          library: true,
        });
        return {
          status: 'prepared' as const,
          provider: 'plex' as const,
          codec: candidate.codec,
          path: output,
        };
      }
    }

    if (server.type === 'jellyfin' || server.type === 'emby') {
      let candidates = await this.mediaServerCache.candidates(
        server,
        program.externalKey,
        request.sdh,
      );
      if (options.acceptText) {
        const accepted: typeof candidates = [];
        for (const candidate of candidates) {
          if (
            await options.acceptText({
              type: 'external',
              codec: candidate.codec,
              title: candidate.title,
              languageCodeISO6392: 'eng',
              sdh: candidate.hearingImpaired,
              forced: false,
              default: false,
            })
          )
            accepted.push(candidate);
        }
        candidates = accepted;
      }
      const matches =
        request.libraryStreamId === undefined
          ? candidates
          : candidates.filter((s) => s.id === request.libraryStreamId);
      if (request.libraryStreamId !== undefined || candidates.length > 0) {
        const candidate = matches[0];
        if (matches.length !== 1 || !candidate)
          return {
            status: 'needs-selection' as const,
            provider: server.type,
            candidates: candidates.map((s) => ({
              id: s.id,
              title: s.title,
              sdh: s.hearingImpaired,
              codec: s.codec,
            })),
          };
        const output = await this.mediaServerCache.prepare({
          program,
          server,
          streamSource,
          identity,
          candidate,
        });
        return {
          status: 'prepared' as const,
          provider: server.type,
          codec: candidate.codec,
          path: output,
        };
      }
    }

    if (
      text &&
      options.reuseExistingText !== false &&
      (!options.acceptText || (await options.acceptText(text)))
    )
      return {
        status: 'existing-text-track' as const,
        codec: text.codec,
        path: text.path,
        streamIndex: text.index,
      };

    if (
      options.acceptText &&
      !(await options.acceptText({
        type: 'external',
        codec: 'srt',
        languageCodeISO6392: 'eng',
        forced: false,
        default: false,
        sdh: request.sdh,
      }))
    )
      return {
        status: 'unavailable' as const,
        provider: 'pgs-ocr' as const,
        reason: 'Playback preferences do not accept OCR SRT output',
      };

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
