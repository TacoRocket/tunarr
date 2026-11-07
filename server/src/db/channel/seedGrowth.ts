import type { LineupItem } from '../derived_types/Lineup.ts';

export function getSeedGrowthWindow(
  items: readonly LineupItem[],
  startTime: number,
  now: number,
) {
  const durationMs = items.reduce((sum, item) => sum + item.durationMs, 0);
  if (durationMs <= 0 || now < startTime) return;

  const cycleElapsed = (now - startTime) % durationMs;
  let offset = 0;
  for (const [currentIndex, item] of items.entries()) {
    if (cycleElapsed < offset + item.durationMs) {
      return {
        currentIndex,
        elapsedInItem: cycleElapsed - offset,
        remainingMs: durationMs - cycleElapsed,
      };
    }
    offset += item.durationMs;
  }
  return;
}
