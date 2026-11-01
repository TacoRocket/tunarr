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
  }: {
    program: ProgramWithRelationsOrm;
    server: MediaSourceWithRelations;
    streamSource: StreamSource;
    identity: string;
    candidate: PlexSubtitleCandidate;
    sdh: boolean;
  }) {
    const client = await this.clients.getPlexApiClientForMediaSource(server);
    const acquisition = {
      provider: 'plex' as const,
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
    await retireReplacedSubtitleCache(
      this.files.getSubtitleCacheFolder(),
      program.uuid,
      identity,
    );
    return output;
  }
}
