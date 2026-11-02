import { ScheduleValidationError } from '../../types/errors.ts';

export type DiscoveryContributions = {
  interest: number;
  metadata: number;
  catalog: number;
};

/** Normalize each eligible pool before mixing; uniform means one vote per title. */
export function mixDiscoveryCandidates(
  candidates: readonly { id: string; interest: number; metadata: number }[],
  explorationPercent: number,
) {
  const exploration = explorationPercent / 100;
  const interestTotal = candidates.reduce(
    (sum, item) => sum + item.interest,
    0,
  );
  const metadataTotal = candidates.reduce(
    (sum, item) => sum + item.metadata,
    0,
  );
  const shares = {
    interest: interestTotal > 0 ? 1 - exploration : 0,
    metadata: metadataTotal > 0 ? exploration * 0.8 : 0,
    catalog: candidates.length > 0 ? exploration * 0.2 : 0,
  };
  const availableShare = shares.interest + shares.metadata + shares.catalog;
  if (availableShare <= 0) {
    throw new ScheduleValidationError(
      'No eligible titles match the enabled recommendation pools. Increase Discovery or choose different seeds.',
    );
  }
  return candidates.map((candidate) => {
    const contributions: DiscoveryContributions = {
      interest:
        interestTotal > 0
          ? (shares.interest * candidate.interest) /
            interestTotal /
            availableShare
          : 0,
      metadata:
        metadataTotal > 0
          ? (shares.metadata * candidate.metadata) /
            metadataTotal /
            availableShare
          : 0,
      catalog: shares.catalog / candidates.length / availableShare,
    };
    return {
      id: candidate.id,
      contributions,
      weight:
        contributions.interest + contributions.metadata + contributions.catalog,
    };
  });
}
