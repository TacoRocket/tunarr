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
  for (const position of positions) {
    const listId = random.pick(position.fillerListIds);
    const iterator = iterators[fillerSlotIteratorKey(listId, 'uniform')];
    const filler = iterator?.current({
      slotDuration: -1,
      timeCursor,
      cooldownMs: 0,
    });
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
    selected.push({ ...filler, fillerType: 'post' });
    timeCursor += filler.duration;
  }
  return selected;
}
