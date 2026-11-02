import type { Lineup, ToonamiFeed } from '../db/derived_types/Lineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import axios from 'axios';
import { routesToEtvNext } from './etv/EtvNextRouting.ts';

export async function resolveToonamiFeed(feed: ToonamiFeed) {
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
  etvNextEnabled: boolean = false,
) {
  if (
    lineup.liveRelay?.source === 'spelunkr' &&
    (channel.streamMode !== 'hls' ||
      !routesToEtvNext(
        channel.streamMode,
        etvNextEnabled,
        channel.useEtvNext === true,
      ))
  ) {
    return 'Spelunkr requires HLS with the ErsatzTV next playback engine';
  }
  const supportedMode =
    channel.streamMode === 'hls' ||
    (channel.streamMode === 'hls_direct_v2' &&
      routesToEtvNext(
        channel.streamMode,
        etvNextEnabled,
        channel.useEtvNext === true,
      ));
  if (
    channel.offsetSourceChannelId ||
    !supportedMode ||
    lineup.items.some((item) => item.type !== 'offline') ||
    lineup.schedule
  ) {
    return 'Live feeds require an empty standalone channel using HLS, or HLS Direct v2 with ErsatzTV next, and no content, redirects or saved schedule';
  }
  return undefined;
}
