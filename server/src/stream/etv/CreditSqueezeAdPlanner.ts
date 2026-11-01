import type { FillerProgram } from '@tunarr/types';
import { bindingScopeValues, inject, injectable } from 'inversify';
import NodeCache from 'node-cache';
import { createHash } from 'node:crypto';
import { MersenneTwister19937, Random } from 'random-js';
import { FillerDB } from '../../db/FillerListDB.ts';
import type { StreamLineupProgram } from '../../db/derived_types/StreamLineup.ts';
import {
  fillerSlotIteratorKey,
  type ProgramIterator,
} from '../../services/scheduling/ProgramIterator.ts';
import { selectWholePod } from '../../services/scheduling/selectWholePod.ts';
import { createFillerShuffleIterator } from '../../services/scheduling/slotSchedulerUtil.ts';

type CreditAd = {
  program: StreamLineupProgram;
  startMs: number;
  finishMs: number;
};

// All sessions must share the selected clips for an airing, including concurrent first joins.
@injectable(bindingScopeValues.Singleton)
export class CreditSqueezeAdPlanner {
  private readonly plans = new NodeCache({
    useClones: false,
    maxKeys: 512,
    checkperiod: 60,
  });

  constructor(@inject(FillerDB) private fillerDB: FillerDB) {}

  async select(request: {
    channelId: string;
    programId: string;
    programBeginMs: number;
    fillerListIds: string[];
    creditsDurationMs: number;
    elapsedMs: number;
    retainMs: number;
  }) {
    const key = JSON.stringify([
      request.channelId,
      request.programId,
      request.programBeginMs,
      request.fillerListIds,
    ]);
    let pending = this.plans.get<Promise<CreditAd[]>>(key);
    if (!pending) {
      pending = this.build(
        request.fillerListIds,
        request.creditsDurationMs,
        key,
      );
      pending.catch(() => this.plans.del(key));
      this.plans.set(
        key,
        pending,
        Math.max(60, Math.ceil(request.retainMs / 1000) + 60),
      );
    }
    const plan = await pending;
    const ad = plan.find((clip) => request.elapsedMs < clip.finishMs);
    if (!ad)
      throw new Error(
        'Credit advertisement plan does not cover this playback position',
      );
    return { ...ad, seekMs: Math.max(0, request.elapsedMs - ad.startMs) };
  }

  private async build(
    poolIds: string[],
    durationMs: number,
    key: string,
  ): Promise<CreditAd[]> {
    const seed = createHash('sha256').update(key).digest();
    const random = new Random(
      MersenneTwister19937.seedWithArray(
        Array.from({ length: 8 }, (_, i) => seed.readUInt32LE(i * 4)),
      ),
    );
    const iterators: Record<string, ProgramIterator<FillerProgram>> = {};
    const programs = new Map<string, StreamLineupProgram>();
    for (const poolId of poolIds) {
      const members = (await this.fillerDB.getFillerPrograms(poolId))
        .filter(
          (p): p is StreamLineupProgram =>
            !!p.mediaSourceId &&
            Number.isFinite(p.duration) &&
            p.duration >= 1000,
        )
        .sort((a, b) => a.uuid.localeCompare(b.uuid));
      if (!members.length)
        throw new Error(
          `Credit advertisement pool ${poolId} has no playable clip of at least one second`,
        );
      for (const program of members) programs.set(program.uuid, program);
      iterators[fillerSlotIteratorKey(poolId, 'uniform')] =
        createFillerShuffleIterator(
          members.map((p) => ({
            ...p,
            parentCustomShows: [],
            parentFillerLists: [poolId],
            parentSmartCollections: [],
          })),
          poolId,
          random,
        );
    }
    const result: CreditAd[] = [];
    let cursor = 0;
    while (cursor < durationMs && result.length < 2000) {
      const selected = selectWholePod(
        [{ fillerListIds: poolIds }],
        iterators,
        random,
        cursor,
      )[0];
      const program = selected && programs.get(selected.id);
      if (!program) throw new Error('Could not select a credit advertisement');
      const finishMs = cursor + Math.round(program.duration);
      result.push({ program, startMs: cursor, finishMs });
      cursor = finishMs;
    }
    if (cursor < durationMs)
      throw new Error('Credit advertisement plan exceeds the 2000-clip limit');
    return result;
  }
}
