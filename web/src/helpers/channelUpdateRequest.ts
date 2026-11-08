import type { SaveableChannel, UpdateChannelRequest } from '@tunarr/types';
import { channelSettingsUpdate } from './channelSettingsUpdate.ts';

export function toChannelUpdateRequest(
  channel: SaveableChannel,
  loaded: { startTime?: number; onDemand?: { enabled?: boolean } } | undefined,
): UpdateChannelRequest {
  return {
    ...channelSettingsUpdate(channel),
    ...(channel.startTime !== loaded?.startTime && {
      startTime: channel.startTime,
    }),
    ...(channel.onDemand?.enabled !== loaded?.onDemand?.enabled && {
      onDemand: channel.onDemand,
    }),
  };
}
