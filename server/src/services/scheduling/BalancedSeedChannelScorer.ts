import { chunk } from 'lodash-es';
import throttle from '../../util/throttle.ts';
import type {
  MeilisearchService,
  SeedChannelSource,
} from '../MeilisearchService.ts';
import {
  createSeedChannelScorer,
  SEED_SCORING_BATCH_SIZE,
} from './SeedChannelScorer.ts';
import { createSemanticSeedChannelScorer } from './SemanticSeedChannelScorer.ts';

const AdaptationRate = 0.25;

type ProfileMatch = {
  source: SeedChannelSource;
  kind: 'seed' | 'watched';
  contribution: number;
};

type CandidateProfile = {
  interest: number;
  metadata: number;
  interestMatch: ProfileMatch;
  metadataMatch: ProfileMatch;
};

type MixtureContributions = {
  interest: number;
  metadata: number;
  catalog: number;
};

/** Reconstruct the channel's EWMA from starts, then mix profile/prior at 2:1. */
export async function createBalancedSeedChannelScorer(
  search: Pick<MeilisearchService, 'getSimilarSeedChannelSources'>,
  catalog: SeedChannelSource[],
  seeds: SeedChannelSource[],
  watchedSourceIds: readonly string[],
  metadataScorer?: Awaited<ReturnType<typeof createSeedChannelScorer>>,
) {
  const metadata =
    metadataScorer ?? (await createSeedChannelScorer(catalog, seeds));
  const semantic = await createSemanticSeedChannelScorer(
    search,
    catalog,
    seeds,
  );
  const byId = new Map(catalog.map((source) => [source.id, source]));
  const sourceFor = (id: string) => {
    const source = byId.get(id);
    if (!source) throw new Error(`Missing Balanced source ${id}`);
    return source;
  };

  // Equal source IDs share one retrieval. Each start still gets its own decay
  // coefficient, including repeat plays; history is not reduced to play counts.
  const watchedWeights = new Map<string, number>();
  let seedWeight = 1;
  for (let index = watchedSourceIds.length - 1; index >= 0; index--) {
    if (index % SEED_SCORING_BATCH_SIZE === 0) await throttle();
    const id = watchedSourceIds[index]!;
    const contribution = AdaptationRate * seedWeight;
    if (contribution > 0) {
      sourceFor(id);
      watchedWeights.set(id, (watchedWeights.get(id) ?? 0) + contribution);
    }
    seedWeight *= 1 - AdaptationRate;
  }
  for (const id of watchedWeights.keys()) await semantic.prepareSource(id);

  const profiles = new Map<string, CandidateProfile>();
  for (const batch of chunk(catalog, SEED_SCORING_BATCH_SIZE)) {
    await throttle();
    for (const candidate of batch) {
      const semanticSeed = semantic.seedMatch(candidate.id);
      const metadataSeed = metadata.seedMatch(candidate.id);
      const profile: CandidateProfile = {
        interest: seedWeight * semanticSeed.score,
        metadata: seedWeight * metadataSeed.score,
        interestMatch: {
          source: semanticSeed.seed,
          kind: 'seed',
          contribution: seedWeight * semanticSeed.score,
        },
        metadataMatch: {
          source: metadataSeed.seed,
          kind: 'seed',
          contribution: seedWeight * metadataSeed.score,
        },
      };
      for (const [id, weight] of watchedWeights) {
        const interestContribution = weight * semantic.score(id, candidate.id);
        const metadataContribution = weight * metadata.score(id, candidate.id);
        profile.interest += interestContribution;
        profile.metadata += metadataContribution;
        if (interestContribution > profile.interestMatch.contribution) {
          profile.interestMatch = {
            source: sourceFor(id),
            kind: 'watched',
            contribution: interestContribution,
          };
        }
        if (metadataContribution > profile.metadataMatch.contribution) {
          profile.metadataMatch = {
            source: sourceFor(id),
            kind: 'watched',
            contribution: metadataContribution,
          };
        }
      }
      profiles.set(candidate.id, profile);
    }
  }
  const profileFor = (id: string) => {
    const profile = profiles.get(id);
    if (!profile) throw new Error(`Missing Balanced profile for ${id}`);
    return profile;
  };

  return {
    prepareSource: semantic.prepareSource,
    score(candidateId: string, previousId?: string) {
      const profile = profileFor(candidateId);
      return {
        interestAffinity:
          (2 * profile.interest +
            (previousId ? semantic.score(previousId, candidateId) : 0)) /
          3,
        metadataAffinity:
          (2 * profile.metadata +
            (previousId ? metadata.score(previousId, candidateId) : 0)) /
          3,
      };
    },
    explain(
      candidateId: string,
      previousId: string | undefined,
      contributions: MixtureContributions,
    ) {
      const profile = profileFor(candidateId);
      const total =
        contributions.interest + contributions.metadata + contributions.catalog;
      if (total <= 0)
        throw new Error(
          'Balanced explanation requires positive selection weight',
        );
      const percentage = (value: number) =>
        `${((100 * value) / total).toFixed(1)}%`;
      const reasons = [
        `This choice's weight: ${percentage(contributions.interest)} current interests, ${percentage(contributions.metadata)} broader metadata, ${percentage(contributions.catalog)} catalog discovery.`,
      ];
      if (contributions.interest > 0) {
        const match = profile.interestMatch;
        if (match.contribution > 0) {
          reasons.push(
            ...semantic
              .explain(match.source.id, candidateId)
              .map(
                (reason) =>
                  `Strongest interest match from ${match.kind} title ${match.source.title}: ${reason}`,
              ),
          );
        }
        if (previousId) {
          reasons.push(
            ...semantic
              .explain(previousId, candidateId)
              .map(
                (reason) =>
                  `Follows preceding title ${sourceFor(previousId).title}: ${reason}`,
              ),
          );
        }
      }
      if (contributions.metadata > 0) {
        const match = profile.metadataMatch;
        if (match.contribution > 0) {
          reasons.push(
            ...metadata
              .explain(match.source.id, candidateId)
              .map(
                (reason) =>
                  `Broader connection from ${match.kind} title ${match.source.title}: ${reason}`,
              ),
          );
        }
        if (previousId) {
          reasons.push(
            ...metadata
              .explain(previousId, candidateId)
              .map(
                (reason) =>
                  `Broader connection to preceding title ${sourceFor(previousId).title}: ${reason}`,
              ),
          );
        }
      }
      if (
        contributions.catalog > 0 &&
        contributions.interest === 0 &&
        contributions.metadata === 0
      ) {
        reasons.push(
          'Catalog-wide discovery: every eligible show or movie has an equal chance in this part of the draw.',
        );
      }
      return reasons;
    },
  };
}
