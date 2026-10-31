import type { CommandModule } from 'yargs';
import { container } from '../container.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import { MediaSourceApiFactory } from '../external/MediaSourceApiFactory.ts';
import { FileSystemService } from '../services/FileSystemService.ts';
import {
  acquiredSubtitles,
  admitAcquiredSubtitleCache,
  retireReplacedSubtitleCache,
  subtitleSourceIdentity,
} from '../services/subtitles/SubtitleCache.ts';
import {
  fetchPlexSubtitle,
  searchPlexSubtitles,
} from '../services/subtitles/PlexSubtitleAcquisition.ts';
import { ExternalSubtitleDownloader } from '../stream/ExternalSubtitleDownloader.ts';
import { ProgramStreamDetailsFetcher } from '../stream/ProgramStreamDetailsFetcher.ts';
import { Result } from '../types/result.ts';
import { KEYS } from '../types/inject.ts';
import type { GlobalArgsType } from './types.ts';

type Args = GlobalArgsType & {
  program: string;
  sdh: boolean;
  candidateTitle?: string;
};
export const PreparePlexSubtitleCommand: CommandModule<GlobalArgsType, Args> = {
  command: 'prepare-plex-subtitle <program>',
  describe:
    'Prepare one English SRT from the configured Plex source; omit --candidate-title to list search results',
  builder: (args) =>
    args
      .positional('program', { type: 'string', demandOption: true })
      .option('sdh', {
        type: 'boolean',
        default: false,
        describe: 'Require SDH rather than dialogue-only subtitles',
      })
      .option('candidate-title', {
        type: 'string',
        describe:
          'Exact title from Plex search; fetching adds the subtitle to Plex and temporarily changes its selection',
      }),
  handler: async (args) => {
    try {
      await preparePlexSubtitle(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.exit(0);
  },
};

async function preparePlexSubtitle(args: Args) {
  const program = await container
    .get<ProgramDB>(KEYS.ProgramDB)
    .getProgramById(args.program);
  if (!program || program.state !== 'ok' || !program.mediaSourceId)
    throw new Error('Program must be present in the library and outside Trash');
  const server = await container
    .get(MediaSourceDB)
    .getById(program.mediaSourceId);
  if (!server || server.type !== 'plex')
    throw new Error('Program must belong to a configured Plex source');
  const fetched = await container.get(ProgramStreamDetailsFetcher).getStream({
    server,
    lineupItem: { ...program, mediaSourceId: program.mediaSourceId },
  });
  if (fetched.isFailure()) throw fetched.error;
  const { streamSource, streamDetails } = fetched.get();
  const folder = container.get(FileSystemService).getSubtitleCacheFolder();
  const identity = await subtitleSourceIdentity(
    streamSource,
    program.canonicalId,
  );
  const existing = (
    await acquiredSubtitles(folder, program.uuid, identity)
  ).find((s) => s.language === 'eng' && s.sdh === args.sdh && !s.forced);
  if (existing) {
    console.log(JSON.stringify({ status: 'cached', path: existing.path }));
    return;
  }
  const available = streamDetails.subtitleDetails?.find(
    (s) =>
      ['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(s.codec) &&
      s.languageCodeISO6392 === 'eng' &&
      s.sdh === args.sdh &&
      !s.forced,
  );
  if (available) {
    console.log(
      JSON.stringify({
        status: 'existing-text-track',
        codec: available.codec,
        path: available.path,
        streamIndex: available.index,
      }),
    );
    return;
  }
  const client = await container
    .get(MediaSourceApiFactory)
    .getPlexApiClientForMediaSource(server);
  const candidates = await searchPlexSubtitles(
    client,
    program.externalKey,
    args.sdh,
  );
  if (!args.candidateTitle) {
    console.log(
      JSON.stringify(
        {
          status: 'choose-candidate',
          candidates: candidates.map((s) => ({
            title: s.title,
            sdh: s.hearingImpaired,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const matches = candidates.filter((s) => s.title === args.candidateTitle);
  const candidate = matches[0];
  if (matches.length !== 1 || !candidate)
    throw new Error(
      'Candidate title must identify exactly one current Plex search result',
    );
  const acquisition = {
    provider: 'plex' as const,
    language: 'eng',
    forced: false,
    sdh: args.sdh,
  };
  const output = await container
    .get(ExternalSubtitleDownloader)
    .downloadSubtitlesIfNecessary(
      {
        uuid: program.uuid,
        externalKey: program.externalKey,
        externalSourceId: server.uuid,
        sourceType: server.type,
      },
      {
        codec: 'srt',
        streamIndex: undefined,
        key: JSON.stringify([identity, acquisition]),
        owner: 'tunarr',
        sourceIdentity: identity,
      },
      async () =>
        Result.success(
          await fetchPlexSubtitle(client, program.externalKey, candidate),
        ),
    );
  if (!output) throw new Error('Plex subtitle was not cached');
  await admitAcquiredSubtitleCache(
    output,
    program.uuid,
    identity,
    acquisition,
    streamSource,
    program.canonicalId,
  );
  await retireReplacedSubtitleCache(folder, program.uuid, identity);
  console.log(JSON.stringify({ status: 'prepared', path: output }));
}
