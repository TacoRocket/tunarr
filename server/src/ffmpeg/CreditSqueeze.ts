import type { ChannelCreditSqueezeSettings } from '@tunarr/types';
import type { ChannelOrmWithTranscodeConfig } from '../db/schema/derivedTypes.ts';
import type { ContentBackedStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import type { StreamDetails, StreamSource } from '../stream/types.ts';
import {
  episodeEndingChapter,
  finalCreditsStart,
} from '../util/programChapterUtil.ts';

export type CreditSqueezePlayback = {
  backgroundImage: string;
  startSeconds: number;
  sourceOffsetSeconds: number;
  advertisement?: { source: StreamSource; seekMs: number; elapsedMs: number };
  playbackDurationMs?: number;
};

export function supportsNextCreditSqueeze(
  channel: Pick<
    ChannelOrmWithTranscodeConfig,
    'transcodeConfig' | 'advanceAtFinalCredits'
  >,
) {
  const config = channel.transcodeConfig;
  return (
    config.hardwareAccelerationMode === 'vaapi' &&
    !config.disableHardwareEncoding &&
    !config.disableHardwareFilters &&
    !channel.advanceAtFinalCredits
  );
}

export function resolveCreditSqueeze(
  settings: ChannelCreditSqueezeSettings | null | undefined,
  details: StreamDetails,
  item: ContentBackedStreamLineupItem,
  seekMs: number,
  durationMs: number,
  useEpisodeEnding = false,
): (CreditSqueezePlayback & { startMs: number; endMs: number }) | undefined {
  if (
    !settings?.enabled ||
    item.type !== 'program' ||
    details.audioOnly ||
    !details.videoDetails
  )
    return;
  const chapters = details.chapters ?? [];
  const sourceDuration = Math.min(
    item.program.duration,
    details.sourceDuration?.asMilliseconds() ?? item.program.duration,
  );
  const episodeAds = useEpisodeEnding && item.program.type === 'episode';
  const prepared = episodeAds ? details.preparedEnding : undefined;
  const ending = episodeAds
    ? episodeEndingChapter(
        chapters,
        sourceDuration,
        prepared?.chapterType === 'chapter' ? prepared : undefined,
      )
    : undefined;
  const startMs =
    ending?.startTime ??
    finalCreditsStart(
      prepared?.chapterType === 'outro' ? [prepared] : chapters,
      sourceDuration,
    );
  const endMs = ending?.endTime ?? seekMs + durationMs;
  if (
    startMs === undefined ||
    startMs >= Math.min(endMs, seekMs + durationMs) ||
    seekMs >= endMs
  )
    return;
  return {
    startMs,
    endMs,
    backgroundImage: settings.backgroundImage,
    startSeconds: Math.max(0, startMs - seekMs) / 1000,
    sourceOffsetSeconds: seekMs / 1000,
  };
}
