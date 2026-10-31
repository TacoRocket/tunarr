import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';
import { fetchPlexSubtitle } from './PlexSubtitleAcquisition.ts';

const candidate = {
  id: '2',
  streamType: 3,
  key: '/library/streams/2',
  title: 'Example release',
  codec: 'srt',
  selected: false,
  forced: false,
  hearingImpaired: false,
};
const before = {
  MediaContainer: {
    Metadata: [{ Media: [{ Part: [{ id: '1', Stream: [] }] }] }],
  },
};
const downloaded = {
  MediaContainer: {
    Metadata: [
      {
        Media: [
          {
            Part: [
              { id: '1', Stream: [{ ...candidate, id: '3', selected: true }] },
            ],
          },
        ],
      },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

describe('Plex subtitle acquisition failures', () => {
  it('reports the download failure as well as a subsequent restore failure', async () => {
    const client = {
      doPut: vi.fn().mockResolvedValue(undefined),
      doGet: vi
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(downloaded)
        .mockRejectedValueOnce(new Error('Subtitle download failed'))
        .mockRejectedValueOnce(new Error('Selection readback failed')),
    } as unknown as PlexApiClient;
    await expect(fetchPlexSubtitle(client, '1', candidate)).rejects.toThrow(
      'Subtitle download failed; Plex subtitle selection restoration also failed: Selection readback failed',
    );
  });

  it('warns after a polling timeout that Plex can still finish and change the selection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000).mockReturnValueOnce(0);
    const client = {
      doPut: vi.fn().mockResolvedValue(undefined),
      doGet: vi.fn().mockResolvedValue(before),
    } as unknown as PlexApiClient;
    await expect(fetchPlexSubtitle(client, '1', candidate)).rejects.toThrow(
      'Plex may still finish downloading and change the selected subtitle; check Plex',
    );
  });
});
