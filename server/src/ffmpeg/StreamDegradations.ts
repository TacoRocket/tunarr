import type { SubtitleStreamDetails } from '../stream/types.ts';
import type { StreamDegradation, StreamDegradationCode } from '@tunarr/types';

/**
 * The ways one transcode is not running as configured (#68). Whatever makes
 * the fallback decision records it here, and the live session reports it
 * through the sessions API. One entry per code, so the list is bounded by
 * the number of codes.
 */
export class StreamDegradations {
  readonly #byCode = new Map<StreamDegradationCode, StreamDegradation>();

  add(code: StreamDegradationCode, message: string, now: number = Date.now()) {
    if (!this.#byCode.has(code)) {
      this.#byCode.set(code, { code, message, firstSeen: now });
    }
  }

  list(): StreamDegradation[] {
    return [...this.#byCode.values()];
  }
}

/**
 * The degradations of the item that just started, keeping the earlier
 * firstSeen for any that continue from the previous item. A channel whose
 * GPU never does low power then reports it since the stream started, not
 * since the latest episode.
 */
export function continueDegradations(
  previous: readonly StreamDegradation[],
  next: readonly StreamDegradation[],
): StreamDegradation[] {
  return next.map((degradation) => {
    const prior = previous.find((p) => p.code === degradation.code);
    return prior ? { ...degradation, firstSeen: prior.firstSeen } : degradation;
  });
}

export function describeSubtitleTrack(stream: SubtitleStreamDetails): string {
  const language = stream.language ?? stream.languageCodeISO6392 ?? 'unknown';
  const title = stream.title ? `, "${stream.title}"` : '';
  return stream.index !== undefined && stream.index !== null
    ? `track ${stream.index} (${language}${title})`
    : `file (${language}${title})`;
}

export function subtitleExtractionMessage(
  wanted: SubtitleStreamDetails,
  selected: SubtitleStreamDetails | null | undefined,
): string {
  const description = describeSubtitleTrack(wanted);
  return selected
    ? `Subtitle ${description} hasn't been extracted, so it can't be shown; showing ${describeSubtitleTrack(selected)} instead.`
    : `Subtitle ${description} hasn't been extracted, so it can't be shown; no subtitles are shown.`;
}
