import type { ChannelStreamMode } from '@tunarr/types';

/**
 * Channel stream modes the ErsatzTV next worker serves.
 *
 * The worker only writes HLS, so `mpegts` still goes through Tunarr's concat
 * session — it reads the worker's playlist instead of Tunarr's own pipeline.
 * `hls_slower` and `hls_direct` are excluded: both are slated for deprecation,
 * and `hls_direct` remuxes without transcoding, which the worker cannot do.
 */
export const EtvNextRoutableModes: ChannelStreamMode[] = [
  'hls',
  'hls_direct_v2',
  'mpegts',
];

export function routesToEtvNext(
  mode: ChannelStreamMode,
  channelOptedIn: boolean,
): boolean {
  return channelOptedIn && EtvNextRoutableModes.includes(mode);
}
