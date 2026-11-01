import { inject, injectable } from 'inversify';
import z from 'zod';
import type {
  MediaSourceWithRelations,
  ProgramWithRelationsOrm,
} from '../../db/schema/derivedTypes.ts';
import { MediaSourceApiFactory } from '../../external/MediaSourceApiFactory.ts';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { StreamSource } from '../../stream/types.ts';
import { Result } from '../../types/result.ts';
import { externalSubtitleDeliveryPath } from '../../util/subtitles.ts';
import { FileSystemService } from '../FileSystemService.ts';
import {
  admitAcquiredSubtitleCache,
  retireReplacedSubtitleCache,
} from './SubtitleCache.ts';

const Item = z.object({
  Id: z.string(),
  MediaSources: z.array(
    z.object({
      Id: z.string(),
      MediaStreams: z.array(
        z.object({
          Index: z.number().int().nonnegative(),
          Type: z.string(),
          Codec: z.string().nullish(),
          Language: z.string().nullish(),
          IsExternal: z.boolean().nullish(),
          IsForced: z.boolean().nullish(),
          IsHearingImpaired: z.boolean().nullish(),
          Title: z.string().nullish(),
          DisplayTitle: z.string().nullish(),
        }),
      ),
    }),
  ),
});

export type MediaServerLibrarySubtitle = {
  id: string;
  key: string;
  codec: 'srt' | 'ass';
  title?: string;
  hearingImpaired: boolean;
  forced: false;
};

/** Jellyfin and Emby expose the same item/source/stream subtitle addressing. */
export function mediaServerLibrarySubtitles(
  raw: unknown,
  itemId: string,
  sdh: boolean,
) {
  const item = Item.parse(raw);
  const source = item.MediaSources[0];
  if (item.Id !== itemId || item.MediaSources.length !== 1 || !source)
    throw new Error(
      'Subtitle acquisition requires one matching item and one media version',
    );
  const candidates: MediaServerLibrarySubtitle[] = [];
  for (const stream of source.MediaStreams) {
    const codec = stream.Codec === 'subrip' ? 'srt' : stream.Codec;
    if (
      stream.Type !== 'Subtitle' ||
      !stream.IsExternal ||
      (codec !== 'srt' && codec !== 'ass') ||
      !['eng', 'en'].includes(stream.Language ?? '') ||
      stream.IsForced ||
      (stream.IsHearingImpaired ?? false) !== sdh
    )
      continue;
    // Build a same-server route from metadata IDs; never forward credentials to
    // a provider-supplied absolute DeliveryUrl.
    const key = externalSubtitleDeliveryPath(
      encodeURIComponent(item.Id),
      encodeURIComponent(source.Id),
      {
        Index: stream.Index,
        Codec: codec,
      },
    );
    if (!key) throw new Error('Could not address the library subtitle');
    candidates.push({
      id: JSON.stringify([source.Id, stream.Index]),
      key,
      codec,
      title: stream.Title ?? stream.DisplayTitle ?? undefined,
      hearingImpaired: sdh,
      forced: false,
    });
  }
  return candidates;
}

@injectable()
export class MediaServerSubtitleCache {
  constructor(
    @inject(MediaSourceApiFactory) private clients: MediaSourceApiFactory,
    @inject(ExternalSubtitleDownloader)
    private downloader: ExternalSubtitleDownloader,
    @inject(FileSystemService) private files: FileSystemService,
  ) {}

  private async client(server: MediaSourceWithRelations) {
    if (server.type === 'jellyfin')
      return this.clients.getJellyfinApiClientForMediaSource(server);
    if (server.type === 'emby')
      return this.clients.getEmbyApiClientForMediaSource(server);
    throw new Error('Expected a Jellyfin or Emby media source');
  }

  async candidates(
    server: MediaSourceWithRelations,
    itemId: string,
    sdh: boolean,
  ) {
    try {
      const result =
        server.type === 'jellyfin'
          ? await (
              await this.clients.getJellyfinApiClientForMediaSource(server)
            ).getRawItem(itemId)
          : await (
              await this.clients.getEmbyApiClientForMediaSource(server)
            ).getItem(itemId, ['MediaSources']);
      if (result.isFailure()) throw result.error;
      return mediaServerLibrarySubtitles(result.get(), itemId, sdh);
    } catch (cause) {
      throw new Error(
        `${server.type} library subtitle lookup failed; OCR was not started`,
        { cause },
      );
    }
  }

  async prepare({
    program,
    server,
    streamSource,
    identity,
    candidate,
  }: {
    program: ProgramWithRelationsOrm;
    server: MediaSourceWithRelations;
    streamSource: StreamSource;
    identity: string;
    candidate: MediaServerLibrarySubtitle;
  }) {
    if (server.type !== 'jellyfin' && server.type !== 'emby')
      throw new Error('Expected a Jellyfin or Emby media source');
    const client = await this.client(server);
    const acquisition = {
      provider: server.type,
      title: candidate.title,
      language: 'eng',
      forced: false,
      sdh: candidate.hearingImpaired,
    };
    const output = await this.downloader.downloadSubtitlesIfNecessary(
      {
        uuid: program.uuid,
        externalKey: program.externalKey,
        externalSourceId: server.uuid,
        sourceType: server.type,
      },
      {
        codec: candidate.codec,
        streamIndex: undefined,
        key: JSON.stringify([identity, acquisition, candidate.id]),
        owner: 'tunarr',
        sourceIdentity: identity,
      },
      async () => {
        const text = await client.doGet<string>({
          url: candidate.key,
          responseType: 'text',
          timeout: 30_000,
          maxContentLength: 5 * 1024 * 1024,
        });
        const content = text.replace(/^\uFEFF/, '');
        const hasCue =
          candidate.codec === 'srt'
            ? /^\s*\d+\s*\r?\n\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}/m.test(
                content,
              )
            : /^\[Events\]\s*$/m.test(content) && /^Dialogue:/m.test(content);
        if (!hasCue)
          throw new Error(
            `${server.type} returned no ${candidate.codec.toUpperCase()} cue`,
          );
        return Result.success(text);
      },
    );
    if (!output) throw new Error(`${server.type} subtitle was not cached`);
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
