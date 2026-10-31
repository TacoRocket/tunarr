import { setTimeout as delay } from 'node:timers/promises';
import z from 'zod';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';

const flag = z
  .union([z.boolean(), z.number(), z.string()])
  .optional()
  .transform((v) => v === true || v === 1 || v === '1');
const Stream = z.object({
  id: z.coerce.string(),
  streamType: z.coerce.number(),
  codec: z.string().optional(),
  key: z.string().optional(),
  title: z.string().optional(),
  languageCode: z.string().optional(),
  hearingImpaired: flag,
  forced: flag,
  selected: flag,
});
const Metadata = z.object({
  MediaContainer: z.object({
    Metadata: z.array(
      z.object({
        Media: z.array(
          z.object({
            Part: z.array(
              z.object({
                id: z.coerce.string(),
                Stream: z.array(Stream).default([]),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});
const Search = z.object({
  MediaContainer: z.object({ Stream: z.array(Stream).default([]) }),
});
export type PlexSubtitleCandidate = z.infer<typeof Stream>;

function itemRoute(itemId: string) {
  if (!/^\d+$/.test(itemId)) throw new Error('Expected a Plex numeric item ID');
  return `/library/metadata/${itemId}`;
}
function subtitleRoute(key: string | undefined) {
  if (!key || !/^\/library\/streams\/\d+$/.test(key))
    throw new Error('Expected a Plex subtitle stream route');
  return key;
}
async function part(client: PlexApiClient, itemId: string) {
  const metadata = Metadata.parse(
    await client.doGet<unknown>({ url: itemRoute(itemId), timeout: 30_000 }),
  );
  const items = metadata.MediaContainer.Metadata;
  const media = items[0]?.Media;
  const parts = media?.[0]?.Part;
  if (
    items.length !== 1 ||
    media?.length !== 1 ||
    parts?.length !== 1 ||
    !parts[0]
  ) {
    throw new Error(
      'Subtitle acquisition currently requires one Plex media version and one part',
    );
  }
  return parts[0];
}

export async function searchPlexSubtitles(
  client: PlexApiClient,
  itemId: string,
  sdh: boolean,
) {
  const result = Search.parse(
    await client.doGet<unknown>({
      url: itemRoute(itemId) + '/subtitles',
      timeout: 30_000,
      params: { language: 'en', hearingImpaired: sdh ? 2 : 3, forced: 3 },
    }),
  );
  return result.MediaContainer.Stream.filter(
    (s) =>
      s.streamType === 3 &&
      s.codec === 'srt' &&
      s.languageCode === 'eng' &&
      s.hearingImpaired === sdh &&
      !s.forced,
  );
}

/** Plex's asynchronous fetch selects the new track; restore only our own selection. */
export async function fetchPlexSubtitle(
  client: PlexApiClient,
  itemId: string,
  candidate: PlexSubtitleCandidate,
) {
  const before = await part(client, itemId);
  const previous =
    before.Stream.find((s) => s.streamType === 3 && s.selected)?.id ?? '0';
  const previousIds = new Set(before.Stream.map((s) => s.id));
  let downloaded: PlexSubtitleCandidate | undefined;
  let text: string;
  try {
    await client.doPut({
      url: itemRoute(itemId) + '/subtitles',
      params: { key: subtitleRoute(candidate.key) },
      timeout: 30_000,
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await part(client, itemId);
      downloaded = current.Stream.find(
        (s) =>
          s.streamType === 3 &&
          !previousIds.has(s.id) &&
          s.title === candidate.title &&
          s.codec === 'srt',
      );
      if (downloaded) break;
      await delay(500);
    }
    if (!downloaded)
      throw new Error(
        'Plex subtitle fetch did not finish within the polling window. Plex may still finish downloading and change the selected subtitle; check Plex',
      );
    text = await client.doGet<string>({
      url: subtitleRoute(downloaded.key),
      responseType: 'text',
      timeout: 30_000,
      maxContentLength: 5 * 1024 * 1024,
    });
    // A successful HTTP response may contain an error page instead of subtitles.
    if (
      !/^\s*\d+\s*\r?\n\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}/m.test(
        text.replace(/^\uFEFF/, ''),
      )
    ) {
      throw new Error('Plex returned no SRT cue');
    }
  } catch (original) {
    try {
      await restoreSelection();
    } catch (restoreError) {
      throw new AggregateError(
        [original, restoreError],
        `${original instanceof Error ? original.message : String(original)}; Plex subtitle selection restoration also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
    throw original;
  }
  await restoreSelection();
  return text;

  async function restoreSelection() {
    const current = await part(client, itemId);
    const selected = current.Stream.find(
      (s) => s.streamType === 3 && s.selected,
    );
    if (
      selected &&
      !previousIds.has(selected.id) &&
      selected.title === candidate.title
    ) {
      if (!/^\d+$/.test(before.id) || !/^\d+$/.test(previous))
        throw new Error('Invalid Plex selection identity');
      await client.doPut({
        url: `/library/parts/${before.id}`,
        params: { subtitleStreamID: previous, allParts: 1 },
        timeout: 30_000,
      });
      const restored = await part(client, itemId);
      if (
        (restored.Stream.find((s) => s.streamType === 3 && s.selected)?.id ??
          '0') !== previous
      ) {
        throw new Error('Plex did not restore its previous subtitle selection');
      }
    }
  }
}
