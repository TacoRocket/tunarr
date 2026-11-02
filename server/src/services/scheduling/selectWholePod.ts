import type { FillerProgram } from '@tunarr/types';
import type { PostProgramPod } from '@tunarr/types/api';
import type { Random } from 'random-js';
import { ScheduleValidationError } from '../../types/errors.ts';
import type { Nullable } from '../../types/util.ts';
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
      let iterator = iterators[fillerSlotIteratorKey(listId, 'uniform')];
      let filler = iterator && offerFresh(iterator, chosenIds, timeCursor);
      if (filler && chosenIds.has(filler.id)) {
        // The picked pool only has clips already in the break. Another of the
        // position's pools may still have a fresh one.
        for (const otherId of position.fillerListIds) {
          const other = iterators[fillerSlotIteratorKey(otherId, 'uniform')];
          if (otherId === listId || !other) continue;
          const candidate = offerFresh(other, chosenIds, timeCursor);
          if (candidate && !chosenIds.has(candidate.id)) {
            iterator = other;
            filler = candidate;
            break;
          }
        }
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

// Advances past clips the break already plays and returns the iterator's
// current clip. Twice the pool size covers the rest of the current shuffle
// pass plus one whole pass, so every clip has been offered; if all of them
// are already in the break, the returned clip is a repeat.
function offerFresh(
  iterator: ProgramIterator<FillerProgram>,
  chosenIds: Set<string>,
  timeCursor: number,
): Nullable<FillerProgram> {
  const state = { slotDuration: -1, timeCursor, cooldownMs: 0 };
  let filler = iterator.current(state);
  const maxSkips = 2 * (iterator.size?.() ?? 0);
  for (
    let skips = 0;
    filler && chosenIds.has(filler.id) && skips < maxSkips;
    skips++
  ) {
    iterator.next();
    filler = iterator.current(state);
  }
  return filler;
}
