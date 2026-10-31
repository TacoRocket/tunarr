import type {
  RandomSlot,
  RandomSlotSchedule,
  ShowSchedulingPresetRequest,
} from '@tunarr/types/api';
import { randomUUID } from 'node:crypto';

const programCounts = {
  marathon: 4,
  primetime: 2,
  'saturday-morning': 1,
  variety: 2,
} as const;

export function createShowSchedulingPreset(
  request: ShowSchedulingPresetRequest,
): RandomSlotSchedule {
  const slots: RandomSlot[] = [];
  const wildcardGroup = randomUUID();
  const common = {
    cooldownMs: 0,
    weight: 100,
    direction: 'asc' as const,
    durationSpec: {
      type: 'dynamic' as const,
      programCount: programCounts[request.preset],
    },
    postProgramPod: request.postProgramPod,
  };

  for (const showId of request.showIds) {
    slots.push({
      ...common,
      id: randomUUID(),
      type: 'show',
      showId,
      order: 'next',
      seasonFilter: [],
      seasonExcludeFilter: [],
    });
    if (request.preset === 'variety') {
      slots.push({
        ...common,
        ...request.wildcard,
        id: randomUUID(),
        // Every wildcard turn advances the same pool's shuffle.
        iterationGroup: wildcardGroup,
        linkMode: 'continue',
        order: 'shuffle',
      });
    }
  }

  return {
    type: 'random',
    maxDays: request.maxDays,
    padMs: 1,
    padStyle: 'slot',
    flexPreference: 'distribute',
    randomDistribution: 'none',
    lockWeights: true,
    slots: slots.map((slot, index) => ({ ...slot, index })),
  };
}
