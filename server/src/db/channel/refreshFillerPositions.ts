import type { ContentItem, LineupItem } from '../derived_types/Lineup.ts';
import { calculateStartTimeOffsets } from '../lineupUtil.ts';
import { ScheduleValidationError } from '../../types/errors.ts';
import { calculateStreamDuration } from '../../stream/StreamProgramCalculator.ts';

export function refreshFillerPositions(
  original: readonly LineupItem[],
  replacements: ReadonlyMap<number, ContentItem>,
  startTime: number,
  now: number,
) {
  const oldOffsets = calculateStartTimeOffsets(original);
  const oldDuration = oldOffsets.at(-1) ?? 0;
  if (oldDuration <= 0)
    throw new ScheduleValidationError('Cannot refresh an empty channel');
  const position = now >= startTime ? (now - startTime) % oldDuration : null;
  const currentIndex =
    position === null
      ? -1
      : original.findIndex(
          (item, index) =>
            position < (oldOffsets[index] ?? 0) + item.durationMs,
        );
  const playingIndex =
    position === null
      ? -1
      : calculateStreamDuration(now, startTime, oldDuration, {
          items: original,
          startTimeOffsets: oldOffsets,
        }).currentProgramIndex;
  let refreshedPositions = 0;
  const items = original.map((item, index) => {
    const replacement = replacements.get(index);
    // Playback may already select the next clip during the current item's tail.
    if (!replacement || index === currentIndex || index === playingIndex)
      return item;
    refreshedPositions++;
    return replacement;
  });
  const offsets = calculateStartTimeOffsets(items);
  const currentOffset = offsets[currentIndex] ?? 0;
  const elapsed =
    position === null ? 0 : position - (oldOffsets[currentIndex] ?? 0);
  return {
    items,
    matchedPositions: replacements.size,
    refreshedPositions,
    preservedCurrentIndex: playingIndex < 0 ? null : playingIndex,
    durationMs: offsets.at(-1) ?? 0,
    startTime:
      position === null || refreshedPositions === 0
        ? startTime
        : now - currentOffset - elapsed,
  };
}
