import { MersenneTwister19937, Random } from 'random-js';
import { expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import { ShowPoolProgramIterator } from './ShowPoolProgramIterator.ts';
import type { SlotSchedulerProgram } from './slotSchedulerUtil.ts';

test('keeps same-show pairs ordered and gives unequal-sized shows one turn each', () => {
  // The flat collection shuffle produced four mixed-show pairs out of six
  // with these show sizes and seed, including a same-show pair out of order.
  const programs: SlotSchedulerProgram[] = ['a', 'b', 'c'].flatMap((show, s) =>
    Array.from({ length: 4 + s * 2 }, (_, i) => ({
      ...createFakeProgramOrm({
        uuid: `${show}-${i + 1}`,
        type: 'episode',
        episode: i + 1,
        seasonNumber: 1,
        tvShowUuid: show,
        show: { uuid: show },
        duration: 60_000,
      }),
      parentCustomShows: [],
      parentFillerLists: [],
      parentSmartCollections: [],
    })),
  );
  const iterator = new ShowPoolProgramIterator(
    programs,
    2,
    new Random(MersenneTwister19937.seed(42)),
  );
  const nextEpisode = new Map(['a', 'b', 'c'].map((show) => [show, 1]));
  for (let cycle = 0; cycle < 5; cycle++) {
    const selectedShows = new Set<string>();
    for (let turn = 0; turn < 3; turn++) {
      const first = iterator.current();
      if (!first) throw new Error('Missing main-show episode');
      const show = first.id.split('-')[0];
      if (!show) throw new Error('Missing show identity');
      expect(selectedShows.has(show)).toBe(false);
      selectedShows.add(show);
      for (let episode = 0; episode < 2; episode++) {
        const expectedEpisode = nextEpisode.get(show);
        if (expectedEpisode === undefined) throw new Error('Unexpected show');
        expect(iterator.current()?.id).toBe(`${show}-${expectedEpisode}`);
        iterator.next();
        const size = programs.filter((p) => p.tvShowUuid === show).length;
        nextEpisode.set(show, (expectedEpisode % size) + 1);
      }
    }
    expect([...selectedShows].sort()).toEqual(['a', 'b', 'c']);
  }
});
