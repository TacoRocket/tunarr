import type { Lineup } from '../db/derived_types/Lineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import axios from 'axios';

export async function resolveToonamiFeed(
  feed: NonNullable<Lineup['liveRelay']>['feed'],
) {
  const west = feed === 'pst' || feed === 'snick-pst';
  const response = await axios.get<string>(
    'https://api.toonamiaftermath.com/streamUrl',
    {
      params: {
        channelName: west ? feed.replace('pst', 'est') : feed,
        useHttps: true,
        timezoneOffset: new Date().getTimezoneOffset() / 60,
        ...(west ? { streamDelay: 180 } : {}),
      },
      responseType: 'text',
      timeout: 10_000,
    },
  );
  const url = new URL(response.data.trim());
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.toonamiaftermath.com')
  ) {
    throw new Error(
      `Toonami returned an unsupported stream address for ${feed}`,
    );
  }
  return url.href;
}

// Shared playback metadata needs a finite duration; this is not a source cutoff.
export const LiveRelayNominalDurationMs = 3_600_000;
export const LiveRelayRetryDelayMs = 10_000;

export function liveRelayConfigurationError(
  channel: ChannelOrm,
  lineup: Lineup,
) {
  if (
    channel.offsetSourceChannelId ||
    channel.streamMode !== 'hls' ||
    lineup.items.some((item) => item.type !== 'offline') ||
    lineup.schedule
  ) {
    return 'The draft relay requires a standalone regular HLS channel with no content, redirects or saved schedule';
  }
  return undefined;
}
