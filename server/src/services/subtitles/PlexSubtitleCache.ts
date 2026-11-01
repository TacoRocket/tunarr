import { inject, injectable } from 'inversify';
import type {
  MediaSourceWithRelations,
  ProgramWithRelationsOrm,
} from '../../db/schema/derivedTypes.ts';
import { MediaSourceApiFactory } from '../../external/MediaSourceApiFactory.ts';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { StreamSource } from '../../stream/types.ts';
import { Result } from '../../types/result.ts';
import { FileSystemService } from '../FileSystemService.ts';
import {
  fetchPlexSubtitle,
  readPlexLibrarySubtitle,
  type PlexSubtitleCandidate,
} from './PlexSubtitleAcquisition.ts';
import {
  admitAcquiredSubtitleCache,
  retireReplacedSubtitleCache,
} from './SubtitleCache.ts';

@injectable()
export class PlexSubtitleCache {
  constructor(
    @inject(MediaSourceApiFactory) private clients: MediaSourceApiFactory,
    @inject(ExternalSubtitleDownloader)
    private downloader: ExternalSubtitleDownloader,
    @inject(FileSystemService) private files: FileSystemService,
  ) {}

  async prepare({
    program,
    server,
    streamSource,
    identity,
    candidate,
    sdh,
    library = false,
  }: {
    program: ProgramWithRelationsOrm;
    server: MediaSourceWithRelations;
    streamSource: StreamSource;
    identity: string;
    candidate: PlexSubtitleCandidate;
    sdh: boolean;
    library?: boolean;
  }) {
    const codec = library ? candidate.codec : 'srt';
    if (codec !== 'srt' && codec !== 'ass')
      throw new Error('Expected a Plex SRT or ASS subtitle');
    const client = await this.clients.getPlexApiClientForMediaSource(server);
    const acquisition = {
      provider: 'plex' as const,
      ...(library ? { title: candidate.title } : {}),
      language: 'eng',
      forced: false,
      sdh,
    };
    const output = await this.downloader.downloadSubtitlesIfNecessary(
      {
        uuid: program.uuid,
        externalKey: program.externalKey,
        externalSourceId: server.uuid,
        sourceType: server.type,
      },
      {
        codec,
        streamIndex: undefined,
        key: JSON.stringify([
          identity,
          acquisition,
          ...(library ? [candidate.id] : []),
        ]),
        owner: 'tunarr',
        sourceIdentity: identity,
      },
      async () =>
        Result.success(
          library
            ? await readPlexLibrarySubtitle(client, candidate)
            : await fetchPlexSubtitle(client, program.externalKey, candidate),
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
    await retireReplacedSubtitleCache(
      this.files.getSubtitleCacheFolder(),
      program.uuid,
      identity,
    );
    return output;
  }
}
