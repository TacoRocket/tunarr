import type { FillerProgram } from '@tunarr/types';
import type { PostProgramPod } from '@tunarr/types/api';
import { MersenneTwister19937, Random } from 'random-js';
import { describe, expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import { ScheduleValidationError } from '../../types/errors.ts';
import {
  fillerSlotIteratorKey,
  type ProgramIterator,
} from './ProgramIterator.ts';
import { selectWholePod } from './selectWholePod.ts';
import {
  createFillerShuffleIterator,
  type SlotSchedulerProgram,
} from './slotSchedulerUtil.ts';

const RETRO = '00000000-0000-4000-8000-000000000001';
const NOSTALGIA = '00000000-0000-4000-8000-000000000002';
const ALL_ADS = '00000000-0000-4000-8000-000000000003';

function clips(ids: string[]): SlotSchedulerProgram[] {
  return ids.map((uuid) => ({
    ...createFakeProgramOrm({
      uuid,
      title: uuid,
      type: 'other_video',
      duration: 30_000,
    }),
    parentFillerLists: [],
    parentCustomShows: [],
    parentSmartCollections: [],
  }));
}

function pools(random: Random, members: Record<string, string[]>) {
  const iterators: Record<string, ProgramIterator<FillerProgram>> = {};
  for (const [poolId, ids] of Object.entries(members)) {
    iterators[fillerSlotIteratorKey(poolId, 'uniform')] =
      createFillerShuffleIterator(clips(ids), poolId, random);
  }
  return iterators;
}

// The selector before count and in-break repeat skipping, kept to show that
// a pod with no possible repeat selects exactly what it used to.
function previousSelectWholePod(
  positions: PostProgramPod,
  iterators: Record<string, ProgramIterator<FillerProgram>>,
  random: Random,
  timeCursor: number,
): FillerProgram[] {
  const selected: FillerProgram[] = [];
  for (const position of positions) {
    const listId = random.pick(position.fillerListIds);
    const iterator = iterators[fillerSlotIteratorKey(listId, 'uniform')]!;
    const filler = iterator.current({
      slotDuration: -1,
      timeCursor,
      cooldownMs: 0,
    })!;
    iterator.next();
    selected.push({ ...filler, fillerType: 'post' });
    timeCursor += filler.duration;
  }
  return selected;
}

describe('selectWholePod', () => {
  test('count plays that many clips from the position, in order', () => {
    const random = new Random(MersenneTwister19937.seed(1));
    const iterators = pools(random, {
      [RETRO]: ['r1', 'r2', 'r3', 'r4', 'r5'],
      [NOSTALGIA]: ['n1', 'n2', 'n3'],
    });

    const pod = selectWholePod(
      [{ fillerListIds: [RETRO], count: 3 }, { fillerListIds: [NOSTALGIA] }],
      iterators,
      random,
      0,
    );

    expect(pod.map((clip) => clip.fillerListId)).toEqual([
      RETRO,
      RETRO,
      RETRO,
      NOSTALGIA,
    ]);
    expect(new Set(pod.map((clip) => clip.id)).size).toBe(4);
    expect(pod.every((clip) => clip.fillerType === 'post')).toBe(true);
  });

  test('count matches repeating the position', () => {
    const members = {
      [RETRO]: ['r1', 'r2', 'r3', 'r4', 'r5'],
      [NOSTALGIA]: ['n1', 'n2', 'n3'],
    };
    const withCount = new Random(MersenneTwister19937.seed(7));
    const repeated = new Random(MersenneTwister19937.seed(7));
    const countIterators = pools(withCount, members);
    const repeatedIterators = pools(repeated, members);

    for (let pod = 0; pod < 20; pod++) {
      expect(
        selectWholePod(
          [
            { fillerListIds: [RETRO], count: 2 },
            { fillerListIds: [NOSTALGIA] },
          ],
          countIterators,
          withCount,
          0,
        ),
      ).toEqual(
        selectWholePod(
          [
            { fillerListIds: [RETRO] },
            { fillerListIds: [RETRO] },
            { fillerListIds: [NOSTALGIA] },
          ],
          repeatedIterators,
          repeated,
          0,
        ),
      );
    }
  });

  test('a clip never plays twice in one break when its pool has another', () => {
    const random = new Random(MersenneTwister19937.seed(3));
    // "Any ad" overlaps the retro pool, the usual shape of a catch-all slot.
    const iterators = pools(random, {
      [RETRO]: ['r1', 'r2', 'r3'],
      [ALL_ADS]: ['r1', 'r2', 'r3', 'a1', 'a2'],
    });

    for (let pod = 0; pod < 200; pod++) {
      const selected = selectWholePod(
        [
          { fillerListIds: [RETRO], count: 2 },
          { fillerListIds: [ALL_ADS], count: 2 },
        ],
        iterators,
        random,
        0,
      );
      expect(new Set(selected.map((clip) => clip.id)).size).toBe(4);
    }
  });

  test('a pool smaller than the break repeats instead of failing', () => {
    const random = new Random(MersenneTwister19937.seed(5));
    const iterators = pools(random, { [RETRO]: ['only'] });

    const pod = selectWholePod(
      [{ fillerListIds: [RETRO], count: 3 }],
      iterators,
      random,
      0,
    );

    expect(pod.map((clip) => clip.id)).toEqual(['only', 'only', 'only']);
  });

  test('a pod that cannot repeat selects what it did before', () => {
    const members = {
      [RETRO]: ['r1', 'r2', 'r3', 'r4'],
      [NOSTALGIA]: ['n1', 'n2', 'n3'],
      [ALL_ADS]: ['a1', 'a2'],
    };
    const positions: PostProgramPod = [
      { fillerListIds: [RETRO] },
      { fillerListIds: [NOSTALGIA, ALL_ADS] },
    ];
    const current = new Random(MersenneTwister19937.seed(11));
    const previous = new Random(MersenneTwister19937.seed(11));
    const currentIterators = pools(current, members);
    const previousIterators = pools(previous, members);

    for (let pod = 0; pod < 100; pod++) {
      expect(
        selectWholePod(positions, currentIterators, current, pod * 60_000),
      ).toEqual(
        previousSelectWholePod(
          positions,
          previousIterators,
          previous,
          pod * 60_000,
        ),
      );
    }
  });

  test('a missing pool still fails generation', () => {
    const random = new Random(MersenneTwister19937.seed(1));
    expect(() =>
      selectWholePod([{ fillerListIds: [RETRO] }], {}, random, 0),
    ).toThrow(ScheduleValidationError);
  });
});
