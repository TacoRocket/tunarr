import type { SeedChannelRollingConfig } from '@tunarr/types/schemas';
import type { Random } from 'random-js';

/** Extra episode airtime can dilute movies, but never extends the target past the limit. */
export function rollingSeedTargetMs(
  config: SeedChannelRollingConfig,
  movieMs: number,
) {
  const minimum = config.minimumHours * 3_600_000;
  const maximum = config.maximumHours * 3_600_000;
  const balancedDuration =
    movieMs === 0
      ? minimum
      : config.moviePercent === 0
        ? maximum
        : movieMs / (config.moviePercent / 100);
  return Math.min(maximum, Math.max(minimum, balancedDuration));
}

/** Weighted sampling without replacement preserves discovery chances in a bounded shortlist. */
export function drawSeedShortlist(
  candidates: readonly { id: string; weight: number }[],
  count: number,
  random: Random,
) {
  const pending = candidates.filter((candidate) => candidate.weight > 0);
  const selected = new Set<string>();
  while (pending.length > 0 && selected.size < count) {
    let ticket = random.real(
      0,
      pending.reduce((sum, candidate) => sum + candidate.weight, 0),
      false,
    );
    let index = pending.length - 1;
    for (let i = 0; i < pending.length; i++) {
      ticket -= pending[i]!.weight;
      if (ticket < 0) {
        index = i;
        break;
      }
    }
    const [chosen] = pending.splice(index, 1);
    selected.add(chosen!.id);
  }
  return selected;
}
