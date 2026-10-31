import type { Lineup } from '../db/derived_types/Lineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import { z } from 'zod/v4';

export const LiveRelayConfigSchema = z
  .object({
    source: z.literal('toonami-aftermath'),
  })
  .strict();

export const ToonamiAftermathUrl =
  'http://api.toonamiaftermath.com:3000/est/playlist.m3u8';

// Draft checkpoint only: this retains the probe's finite session boundary.
// Issue #59 tracks keeping the connection open and correcting outage recovery.
export const LiveRelaySessionDurationMs = 60 * 60 * 1000;

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
