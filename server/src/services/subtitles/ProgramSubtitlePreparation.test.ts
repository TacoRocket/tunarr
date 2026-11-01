import '../../container.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { SubtitleStreamDetails } from '../../stream/types.ts';
import { Result } from '../../types/result.ts';
import { acquiredSubtitles, subtitleSourceIdentity } from './SubtitleCache.ts';
import { PlexSubtitleCache } from './PlexSubtitleCache.ts';
import { MediaServerSubtitleCache } from './MediaServerSubtitleCache.ts';
import {
  ProgramSubtitlePreparation,
  ProgramSubtitleRequest,
} from './ProgramSubtitlePreparation.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello\n';
const ass =
  '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,24\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello\n';
const request = { programId: 'program', sdh: false };
function libraryTrack(id: string, codec = 'srt') {
  return {
    id,
    streamType: 3,
    codec,
    key: `/library/streams/${id}`,
    languageCode: 'eng',
    title: 'English',
    hearingImpaired: false,
    forced: false,
  };
}
async function harness(
  tracks: object[],
  subtitles: SubtitleStreamDetails[] = [],
  sourceType: 'plex' | 'jellyfin' | 'emby' = 'plex',
) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), 'plex-library-subtitles-'),
  );
  directories.push(folder);
  const source = {
    type: 'file' as const,
    path: path.join(folder, 'movie.mkv'),
  };
  await fs.writeFile(source.path, 'media identity fixture');
  const doGet = vi.fn(async ({ url }: { url: string }) => {
    if (url === '/library/metadata/1')
      return {
        MediaContainer: {
          Metadata: [{ Media: [{ Part: [{ id: '2', Stream: tracks }] }] }],
        },
      };
    const track = tracks.find(
      (t) =>
        ('key' in t && t.key === url) ||
        ('id' in t &&
          'codec' in t &&
          url === `/Videos/1/2/Subtitles/${t.id}/Stream.${t.codec}`),
    );
    if (track && 'codec' in track) return track.codec === 'ass' ? ass : srt;
    throw new Error(`Unexpected Plex request: ${url}`);
  });
  const doPut = vi.fn();
  const getItem = vi.fn(async () =>
    Result.success({
      Id: '1',
      MediaSources: [
        {
          Id: '2',
          MediaStreams: tracks.map((track) => {
            const t = track as ReturnType<typeof libraryTrack>;
            return {
              Index: Number(t.id),
              Type: 'Subtitle',
              Codec: t.codec,
              Language: 'eng',
              IsExternal: true,
              IsHearingImpaired: t.hearingImpaired,
              IsForced: t.forced,
              Title: t.title,
            };
          }),
        },
      ],
    }),
  );
  const clients = {
    getPlexApiClientForMediaSource: async () => ({ doGet, doPut }),
    getJellyfinApiClientForMediaSource: async () => ({
      doGet,
      getRawItem: getItem,
    }),
    getEmbyApiClientForMediaSource: async () => ({ doGet, getItem }),
  } as never;
  const files = { getSubtitleCacheFolder: () => folder } as never;
  const cache = new PlexSubtitleCache(
    clients,
    new ExternalSubtitleDownloader(files),
    files,
  );
  const queueTask = vi.fn(async () => ({
    result: { status: 'prepared', path: 'ocr.srt' },
  }));
  const job = new ProgramSubtitlePreparation(
    {
      getProgramById: async () => ({
        uuid: 'program',
        state: 'ok',
        mediaSourceId: 'source',
        externalKey: '1',
      }),
    } as never,
    { getById: async () => ({ uuid: 'source', type: sourceType }) } as never,
    {
      getStream: async () =>
        Result.success({
          streamSource: source,
          streamDetails: { subtitleDetails: subtitles },
        }),
    } as never,
    files,
    clients,
    cache,
    { allReady: async () => {}, queueTask } as never,
    new MediaServerSubtitleCache(
      clients,
      new ExternalSubtitleDownloader(files),
      files,
    ),
  );
  return { job, doGet, doPut, getItem, queueTask, folder, source };
}

it.each(['jellyfin', 'emby'] as const)(
  'retains %s sidecars outside scanner rows instead of stopping at existing-text-track',
  async (provider) => {
    const h = await harness(
      [libraryTrack('10')],
      [
        {
          type: 'external',
          codec: 'srt',
          path: '/scanner-owned.srt',
          languageCodeISO6392: 'eng',
          sdh: false,
          forced: false,
          default: false,
        },
      ],
      provider,
    );
    const first = await h.job.prepare(request);
    expect(first).toMatchObject({ status: 'prepared', provider, codec: 'srt' });
    expect(
      await acquiredSubtitles(
        h.folder,
        'program',
        await subtitleSourceIdentity(h.source),
      ),
    ).toMatchObject([{ provider, codec: 'srt', title: 'English' }]);
    h.getItem.mockRejectedValue(new Error('server unavailable'));
    expect(await h.job.prepare(request)).toMatchObject({
      status: 'cached',
      provider,
    });
    expect(h.getItem).toHaveBeenCalledTimes(1);
    expect(h.queueTask).not.toHaveBeenCalled();
  },
);

it.each(['srt', 'ass'])(
  'imports existing Plex %s unchanged and reuses the owned cache without contacting Plex',
  async (codec) => {
    const h = await harness([libraryTrack('10', codec)]);
    const first = await h.job.prepare(request);
    expect(first).toMatchObject({
      status: 'prepared',
      provider: 'plex',
      codec,
    });
    if (!('path' in first) || !first.path)
      throw new Error('Missing imported subtitle');
    expect(await fs.readFile(first.path, 'utf8')).toBe(
      codec === 'ass' ? ass : srt,
    );
    expect(first.path.endsWith(`.${codec}`)).toBe(true);
    expect(
      await acquiredSubtitles(
        h.folder,
        'program',
        await subtitleSourceIdentity(h.source),
      ),
    ).toMatchObject([{ codec, title: 'English', path: first.path }]);
    expect(h.doGet.mock.calls.map(([call]) => call.url)).toEqual([
      '/library/metadata/1',
      '/library/streams/10',
    ]);
    h.doGet.mockRejectedValue(new Error('Plex unavailable after import'));
    expect(await h.job.prepare(request)).toMatchObject({
      status: 'cached',
      provider: 'plex',
      path: first.path,
    });
    expect(h.doGet).toHaveBeenCalledTimes(2);
    expect(h.doPut).not.toHaveBeenCalled();
    expect(h.queueTask).not.toHaveBeenCalled();
  },
);

it('keeps ambiguous attached tracks as needs-selection and accepts a stable library stream ID', async () => {
  const h = await harness([libraryTrack('10'), libraryTrack('11', 'ass')]);
  expect(await h.job.prepare(request)).toMatchObject({
    status: 'needs-selection',
    provider: 'plex',
    candidates: [{ id: '10' }, { id: '11' }],
  });
  expect(await h.job.prepare({ ...request, plexStreamId: '11' })).toMatchObject(
    { status: 'prepared', provider: 'plex', codec: 'ass' },
  );
  expect(h.doGet.mock.calls.map(([call]) => call.url)).toEqual([
    '/library/metadata/1',
    '/library/metadata/1',
    '/library/streams/11',
  ]);
  expect(h.queueTask).not.toHaveBeenCalled();
});

it('sends embedded PGS to OCR without an online search or a stream download', async () => {
  const h = await harness(
    [{ ...libraryTrack('12', 'pgs'), key: undefined }],
    [
      {
        type: 'embedded',
        codec: 'hdmv_pgs_subtitle',
        index: 2,
        languageCodeISO6392: 'eng',
        sdh: false,
        forced: false,
        default: false,
      },
    ],
  );
  expect(await h.job.prepare(request)).toMatchObject({
    provider: 'pgs-ocr',
    status: process.platform === 'linux' ? 'prepared' : 'unsupported',
  });
  expect(h.doGet.mock.calls.map(([call]) => call.url)).toEqual([
    '/library/metadata/1',
  ]);
  expect(h.doPut).not.toHaveBeenCalled();
  if (process.platform === 'linux')
    expect(h.queueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pgs-ocr',
        request: expect.objectContaining({ streamIndex: 2 }),
      }),
      30 * 60_000,
    );
});

it('reuses embedded text through normal extraction and never treats a library failure as permission to OCR', async () => {
  const h = await harness(
    [],
    [
      {
        type: 'embedded',
        codec: 'ass',
        index: 2,
        languageCodeISO6392: 'eng',
        sdh: false,
        forced: false,
        default: false,
      },
    ],
  );
  expect(await h.job.prepare(request)).toMatchObject({
    status: 'existing-text-track',
    codec: 'ass',
  });
  expect(h.doGet).not.toHaveBeenCalled();
  h.doGet.mockRejectedValue(new Error('Plex unavailable'));
  await expect(
    h.job.prepare(request, { reuseExistingText: false }),
  ).rejects.toThrow('Plex library subtitle lookup failed');
  expect(h.queueTask).not.toHaveBeenCalled();
});

it('rejects the former online search ID instead of interpreting it as a library stream ID', () => {
  expect(
    ProgramSubtitleRequest.safeParse({ ...request, plexCandidateId: '10' })
      .success,
  ).toBe(false);
});

it('checks the library title against automatic preferences before importing or reusing a copy', async () => {
  const h = await harness([{ ...libraryTrack('10'), title: 'Commentary' }]);
  const acceptText = vi.fn(
    async (subtitle: SubtitleStreamDetails) => subtitle.title !== 'Commentary',
  );
  expect(
    await h.job.prepare(request, { reuseExistingText: false, acceptText }),
  ).toMatchObject({ status: 'unavailable', provider: 'pgs-ocr' });
  expect(h.doGet.mock.calls.map(([call]) => call.url)).toEqual([
    '/library/metadata/1',
  ]);
  expect(acceptText).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Commentary' }),
  );
  expect(await h.job.prepare(request)).toMatchObject({
    status: 'prepared',
    provider: 'plex',
  });
  expect(
    await h.job.prepare(request, { reuseExistingText: false, acceptText }),
  ).toMatchObject({ status: 'unavailable', provider: 'pgs-ocr' });
});
