import type { ChannelCreditSqueezeSettings } from '@tunarr/types';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { StreamDetails, StreamSource } from '../stream/types.ts';
import { finalCreditsStart } from '../util/programChapterUtil.ts';

export type CreditSqueezePlayback = {
  backgroundImage: string;
  startSeconds: number;
  sourceOffsetSeconds: number;
  advertisement?: { source: StreamSource; seekMs: number; elapsedMs: number };
  playbackDurationMs?: number;
};

export function resolveCreditSqueeze(
  settings: ChannelCreditSqueezeSettings | null | undefined,
  details: StreamDetails,
  item: ContentBackedStreamLineupItem,
  seekMs: number,
  durationMs: number,
): CreditSqueezePlayback | undefined {
  if (
    !settings?.enabled ||
    item.type !== 'program' ||
    details.audioOnly ||
    !details.videoDetails
  )
    return;
  const marker = finalCreditsStart(
    details.chapters ?? [],
    Math.min(
      item.program.duration,
      details.sourceDuration?.asMilliseconds() ?? item.program.duration,
    ),
  );
  if (marker === undefined || marker >= seekMs + durationMs) return;
  return {
    backgroundImage: settings.backgroundImage,
    startSeconds: Math.max(0, marker - seekMs) / 1000,
    sourceOffsetSeconds: seekMs / 1000,
  };
}
