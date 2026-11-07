import { ScheduleValidationError } from '../../types/errors.ts';

export const BalancedLookbackShare = 0.05;

export type DiscoveryContributions = {
  interest: number;
  metadata: number;
  risk: number;
  lookback: number;
};

/** Normalize each eligible pool before mixing, then redistribute empty shares. */
export function mixDiscoveryCandidates(
  candidates: readonly ({ id: string } & DiscoveryContributions)[],
  explorationPercent: number,
) {
  const exploration = explorationPercent / 100;
  const currentShare = 1 - BalancedLookbackShare;
  const shares: DiscoveryContributions = {
    interest: currentShare * (1 - exploration),
    metadata: currentShare * exploration * 0.8,
    risk: currentShare * exploration * 0.2,
    lookback: BalancedLookbackShare,
  };
  const pools = ['interest', 'metadata', 'risk', 'lookback'] as const;
  const totals: DiscoveryContributions = {
    interest: 0,
    metadata: 0,
    risk: 0,
    lookback: 0,
  };
  for (const candidate of candidates) {
    for (const pool of pools) totals[pool] += candidate[pool];
  }
  const availableShare = pools.reduce(
    (sum, pool) => sum + (totals[pool] > 0 ? shares[pool] : 0),
    0,
  );
  if (availableShare <= 0) {
    throw new ScheduleValidationError(
      'No eligible titles match the enabled recommendation pools. Increase Discovery or choose different seeds.',
    );
  }
  return candidates.map((candidate) => {
    const contributions: DiscoveryContributions = {
      interest: 0,
      metadata: 0,
      risk: 0,
      lookback: 0,
    };
    for (const pool of pools) {
      if (totals[pool] > 0)
        contributions[pool] =
          (shares[pool] * candidate[pool]) / totals[pool] / availableShare;
    }
    return {
      id: candidate.id,
      contributions,
      weight: pools.reduce((sum, pool) => sum + contributions[pool], 0),
    };
  });
}
