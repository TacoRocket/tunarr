import type { CondensedChannelProgram, FillerProgram } from '@tunarr/types';
import type {
  GenerateBlockRequest,
  GenerateBlockResult,
} from '@tunarr/types/api';
import { inject, injectable } from 'inversify';
import { createEntropy, MersenneTwister19937, Random } from 'random-js';
import { MaterializeLineupCommand } from '../../commands/MaterializeLineupCommand.ts';
import { FillerDB } from '../../db/FillerListDB.ts';
import type { ProgramDB } from '../../db/ProgramDB.ts';
import { ScheduleValidationError } from '../../types/errors.ts';
import { KEYS } from '../../types/inject.ts';
import {
  fillerSlotIteratorKey,
  type ProgramIterator,
} from './ProgramIterator.ts';
import { selectWholePod } from './selectWholePod.ts';
import {
  createFillerShuffleIterator,
  hasSchedulableDuration,
} from './slotSchedulerUtil.ts';

@injectable()
export class BlockGenerationService {
  constructor(
    @inject(KEYS.ProgramDB) private programDB: ProgramDB,
    @inject(FillerDB) private fillerDB: FillerDB,
    @inject(MaterializeLineupCommand)
    private materializeLineup: MaterializeLineupCommand,
  ) {}

  async generate(request: GenerateBlockRequest): Promise<GenerateBlockResult> {
    const programIds = [
      ...new Set(
        request.entries.flatMap((entry) =>
          entry.type === 'program' ? [entry.programId] : [],
        ),
      ),
    ];
    const poolIds = [
      ...new Set(
        request.entries.flatMap((entry) =>
          entry.type === 'break'
            ? entry.positions.flatMap((position) => position.fillerListIds)
            : [],
        ),
      ),
    ];
    const [programs, pools] = await Promise.all([
      this.programDB.getProgramsByIds(programIds),
      this.fillerDB.getFillerListsByIds(poolIds),
    ]);
    const programsById = new Map(
      programs.map((program) => [program.uuid, program]),
    );
    const existingPools = new Set(pools.map((pool) => pool.uuid));
    for (const [index, entry] of request.entries.entries()) {
      if (entry.type === 'program') {
        const program = programsById.get(entry.programId);
        if (!program || !hasSchedulableDuration(program.duration)) {
          throw new ScheduleValidationError(
            `Block entry ${index}: program ${entry.programId} is missing or has no playable whole duration`,
          );
        }
      } else {
        for (const position of entry.positions) {
          for (const poolId of position.fillerListIds) {
            if (!existingPools.has(poolId)) {
              throw new ScheduleValidationError(
                `Block entry ${index}: filler list ${poolId} does not exist`,
              );
            }
          }
        }
      }
    }

    const seed = request.seed ?? createEntropy();
    const random = new Random(MersenneTwister19937.seedWithArray(seed));
    const iterators: Record<string, ProgramIterator<FillerProgram>> = {};
    for (const poolId of poolIds) {
      const members = (await this.fillerDB.getFillerPrograms(poolId))
        .filter((program) => hasSchedulableDuration(program.duration))
        .map((program) => ({
          ...program,
          parentCustomShows: [],
          parentFillerLists: [poolId],
          parentSmartCollections: [],
        }));
      if (members.length === 0) {
        throw new ScheduleValidationError(
          `Block filler list ${poolId} has no playable whole clip`,
        );
      }
      iterators[fillerSlotIteratorKey(poolId, 'uniform')] =
        createFillerShuffleIterator(members, poolId, random);
    }

    const lineup: CondensedChannelProgram[] = [];
    const startTimeOffsets: number[] = [];
    let durationMs = 0;
    for (const entry of request.entries) {
      let selected: CondensedChannelProgram[];
      if (entry.type === 'program') {
        const program = programsById.get(entry.programId);
        if (!program) {
          throw new ScheduleValidationError(
            `Block program ${entry.programId} does not exist`,
          );
        }
        selected = [
          {
            type: 'content',
            id: program.uuid,
            duration: program.duration,
          },
        ];
      } else {
        selected = selectWholePod(
          entry.positions,
          iterators,
          random,
          durationMs,
        );
      }
      for (const program of selected) {
        startTimeOffsets.push(durationMs);
        lineup.push(program);
        durationMs += program.duration;
      }
    }

    const materialized = await this.materializeLineup.execute({ lineup });
    for (const program of lineup) {
      if ('id' in program && program.id && !materialized[program.id]) {
        throw new ScheduleValidationError(
          `Block program ${program.id} could not be materialized`,
        );
      }
    }
    return {
      lineup,
      programs: materialized,
      startTimeOffsets,
      durationMs,
      seed,
    };
  }
}
