import type { CondensedContentProgram } from '@tunarr/types';
import type { Random } from 'random-js';
import { ScheduleValidationError } from '../../types/errors.ts';
import { getProgramOrderer, type ProgramIterator } from './ProgramIterator.ts';
import { ContentProgramOrderedIterator } from './ProgramOrdereredIterator.ts';
import type { SlotSchedulerProgram } from './slotSchedulerUtil.ts';

// A shuffle bag of shows, each with its own ordered episode iterator.
// Only collection-resolved episodes enter the bag; grouping never widens a filter.
export class ShowPoolProgramIterator
  implements ProgramIterator<CondensedContentProgram>
{
  private shows: ContentProgramOrderedIterator[];
  private showPosition = 0;
  private episodeCount = 0;

  constructor(
    programs: SlotSchedulerProgram[],
    private groupSize: number,
    private random: Random,
  ) {
    if (!Number.isInteger(groupSize) || groupSize < 1) {
      throw new ScheduleValidationError(
        'Show pools require a positive whole program count',
      );
    }
    const byShow = new Map<string, Map<string, SlotSchedulerProgram>>();
    for (const program of programs) {
      const showId = program.show?.uuid ?? program.tvShowUuid;
      if (
        program.type !== 'episode' ||
        !showId ||
        !Number.isFinite(program.duration) ||
        program.duration <= 0
      )
        continue;
      let episodes = byShow.get(showId);
      if (!episodes) {
        episodes = new Map();
        byShow.set(showId, episodes);
      }
      episodes.set(program.uuid, program);
    }
    this.shows = [...byShow.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, episodes]) => episodes.size >= groupSize)
      .map(
        ([, episodes]) =>
          new ContentProgramOrderedIterator(
            [...episodes.values()],
            getProgramOrderer('next'),
            true,
          ),
      );
    if (this.shows.length === 0) {
      throw new ScheduleValidationError(
        `Show pool has no series with at least ${groupSize} playable matching episodes`,
      );
    }
    this.random.shuffle(this.shows);
  }

  current(): CondensedContentProgram | null {
    return this.shows[this.showPosition]?.current() ?? null;
  }

  next(): void {
    this.shows[this.showPosition]?.next();
    this.episodeCount++;
    if (this.episodeCount === this.groupSize) {
      this.episodeCount = 0;
      this.showPosition++;
      if (this.showPosition === this.shows.length) {
        this.showPosition = 0;
        this.random.shuffle(this.shows);
      }
    }
  }

  reset(): void {
    this.shows.forEach((show) => show.reset());
    this.random.shuffle(this.shows);
    this.showPosition = 0;
    this.episodeCount = 0;
  }

  fork(): ProgramIterator<CondensedContentProgram> {
    return this;
  }
}
