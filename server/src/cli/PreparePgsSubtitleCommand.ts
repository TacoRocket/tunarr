import type { CommandModule } from 'yargs';
import { container } from '../container.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import { PgsSubtitleCodecs } from '../ffmpeg/builder/MediaStream.ts';
import { FileSystemService } from '../services/FileSystemService.ts';
import { prepareCachedPgsSubtitle } from '../services/subtitles/PgsSubtitlePreparation.ts';
import { ProgramStreamDetailsFetcher } from '../stream/ProgramStreamDetailsFetcher.ts';
import { KEYS } from '../types/inject.ts';
import type { GlobalArgsType } from './types.ts';

type Args = GlobalArgsType & { program: string; stream: number; sdh: boolean };

export const PreparePgsSubtitleCommand: CommandModule<GlobalArgsType, Args> = {
  command: 'prepare-pgs-subtitle <program>',
  describe:
    'Convert one English PGS track to the Tunarr subtitle cache (Linux container)',
  builder: (args) =>
    args
      .positional('program', { type: 'string', demandOption: true })
      .option('stream', {
        type: 'number',
        demandOption: true,
        describe:
          'Zero-based stream index across all tracks, not just subtitles',
      })
      .option('sdh', {
        type: 'boolean',
        default: false,
        describe:
          'Label this selected track as subtitles for deaf and hard-of-hearing viewers',
      }),
  handler: async (args) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      if (process.platform !== 'linux')
        throw new Error(
          'OCR cache preparation currently requires the Linux container',
        );
      if (!Number.isSafeInteger(args.stream) || args.stream < 0)
        throw new Error('Expected a nonnegative stream index');
      const program = await container
        .get<ProgramDB>(KEYS.ProgramDB)
        .getProgramById(args.program);
      if (!program || program.state !== 'ok' || !program.mediaSourceId)
        throw new Error(
          'Program must be present in the library and outside Trash',
        );
      const server = await container
        .get(MediaSourceDB)
        .getById(program.mediaSourceId);
      if (!server) throw new Error('Program has no configured media source');
      const fetched = await container
        .get(ProgramStreamDetailsFetcher)
        .getStream({
          server,
          lineupItem: { ...program, mediaSourceId: program.mediaSourceId },
        });
      if (fetched.isFailure()) throw fetched.error;
      const { streamSource, streamDetails } = fetched.get();
      if (streamSource.type !== 'file')
        throw new Error(
          'PGS OCR requires a locally accessible Matroska file; configure the media source path mapping',
        );
      const track = streamDetails.subtitleDetails?.find(
        (s) => s.type === 'embedded' && s.index === args.stream,
      );
      if (
        !track ||
        !PgsSubtitleCodecs.includes(track.codec) ||
        track.languageCodeISO6392 !== 'eng'
      )
        throw new Error(
          'Selected stream must be an embedded English PGS track',
        );
      const result = await prepareCachedPgsSubtitle({
        programId: program.uuid,
        inputPath: streamSource.path,
        revision: program.canonicalId,
        streamIndex: args.stream,
        forced: track.forced,
        sdh: args.sdh,
        cacheFolder: container.get(FileSystemService).getSubtitleCacheFolder(),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30 * 60_000),
        ]),
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    process.exit(0);
  },
};
