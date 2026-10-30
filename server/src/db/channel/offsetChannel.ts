// An offset channel plays its source channel's lineup a whole number of hours
// later, like an East/West Coast feed. It is stored as an ordinary channel
// that Tunarr overwrites from its source whenever the source changes, so
// playback and the guide read it like any other channel.

const HourMs = 60 * 60 * 1000;

/**
 * The offset channel's start time: the source's, plus the offset. A channel
 * loops its lineup, so moving the start by whole loops changes nothing that
 * plays. Moving it back to the past keeps a recently rebased source from
 * leaving its offset channel off the air until the shifted start arrives.
 */
export function offsetStartTime(
  sourceStartTime: number,
  offsetHours: number,
  durationMs: number,
  now: number,
): number {
  const start = sourceStartTime + offsetHours * HourMs;
  if (start <= now || durationMs <= 0) {
    return start;
  }
  return start - Math.ceil((start - now) / durationMs) * durationMs;
}
