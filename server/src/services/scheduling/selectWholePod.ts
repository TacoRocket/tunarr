import type { FillerProgram } from '@tunarr/types';
import type { PostProgramPod } from '@tunarr/types/api';
import type { Random } from 'random-js';
import { ScheduleValidationError } from '../../types/errors.ts';
import {
  fillerSlotIteratorKey,
  type ProgramIterator,
} from './ProgramIterator.ts';

export function selectWholePod(
  positions: PostProgramPod,
  iterators: Record<string, ProgramIterator<FillerProgram>>,
  random: Random,
  timeCursor: number,
): FillerProgram[] {
  const selected: FillerProgram[] = [];
  const chosenIds = new Set<string>();
  for (const position of positions) {
    for (let draw = 0; draw < (position.count ?? 1); draw++) {
      const listId = random.pick(position.fillerListIds);
      const iterator = iterators[fillerSlotIteratorKey(listId, 'uniform')];
      let filler = iterator?.current({
        slotDuration: -1,
        timeCursor,
        cooldownMs: 0,
      });
      // Skip clips this break already plays. Twice the pool size covers the
      // rest of the current shuffle pass plus one whole pass, so every clip
      // has been offered; if all of them are already in the break, the
      // repeat plays.
      const maxSkips = 2 * (iterator?.size?.() ?? 0);
      for (
        let skips = 0;
        iterator && filler && chosenIds.has(filler.id) && skips < maxSkips;
        skips++
      ) {
        iterator.next();
        filler = iterator.current({
          slotDuration: -1,
          timeCursor,
          cooldownMs: 0,
        });
      }
      if (
        !iterator ||
        !filler ||
        !Number.isFinite(filler.duration) ||
        filler.duration <= 0
      ) {
        throw new ScheduleValidationError(
          `After-show pod pool ${listId} has no playable whole clip`,
        );
      }
      iterator.next();
      chosenIds.add(filler.id);
      selected.push({ ...filler, fillerType: 'post' });
      timeCursor += filler.duration;
    }
  }
  return selected;
}
