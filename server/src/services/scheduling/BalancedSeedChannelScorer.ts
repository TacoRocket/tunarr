import { chunk } from 'lodash-es';
import type { Random } from 'random-js';
import throttle from '../../util/throttle.ts';
import type {
  MeilisearchService,
  SeedChannelSource,
} from '../MeilisearchService.ts';
import {
  createSeedChannelScorer,
  SEED_SCORING_BATCH_SIZE,
} from './SeedChannelScorer.ts';
import type { DiscoveryContributions } from './SeedChannelDiscovery.ts';
import { createSemanticSeedChannelScorer } from './SemanticSeedChannelScorer.ts';

const AdaptationRate = 0.25;
const PreviousTitleShare = 0.1;
const BroadOnlySupport = 0.25;
const CorroborationBonus = 1.5;
const RatingMetadataWeight = 0.25;
const OlderAnchorLimit = 3;

type ProfileMatch = {
  source: SeedChannelSource;
  kind: 'seed' | 'watched';
  contribution: number;
};

type CandidateProfile = {
  interest: number;
  metadata: number;
  support: number;
  supportMatch: ProfileMatch;
  interestMatch: ProfileMatch;
  metadataMatch: ProfileMatch;
};

/** Reconstruct current interests from starts; scheduled titles only nudge supported picks. */
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

  const connection = (leftId: string, rightId: string) => {
    const shared = metadata.connections(leftId, rightId);
    const rating = sourceFor(leftId).rating?.trim().toUpperCase();
    const sameRating =
      !!rating && rating === sourceFor(rightId).rating?.trim().toUpperCase();
    const semanticScore = semantic.score(leftId, rightId);
    // Two shared genres retain their corroboration; other fields count once.
    const ties =
      shared.reduce(
        (count, item) =>
          count + (item.field === 'genres' ? item.names.length : 1),
        0,
      ) +
      Number(sameRating) +
      Number(semanticScore > 0);
    const broadOnly =
      semanticScore === 0 &&
      shared.every(({ field }) => field === 'genres' || field === 'studio');
    return {
      support: ties === 0 ? 0 : ties === 1 && broadOnly ? BroadOnlySupport : 1,
      metadata:
        (metadata.score(leftId, rightId) +
          (sameRating ? RatingMetadataWeight : 0)) *
        (ties >= 2 ? CorroborationBonus : 1),
      reasons: [
        ...shared.map(
          ({ label, names }) => `Shared ${label}: ${names.join(', ')}`,
        ),
        ...(sameRating ? [`Shared content rating: ${rating}`] : []),
        ...semantic.explain(leftId, rightId),
      ],
    };
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
      const seedConnections = seeds.map((seed) => ({
        seed,
        ...connection(seed.id, candidate.id),
      }));
      const metadataSeed = seedConnections.reduce((best, match) =>
        match.metadata > best.metadata ? match : best,
      );
      const supportSeed = seedConnections.reduce((best, match) =>
        match.support > best.support ? match : best,
      );
      const profile: CandidateProfile = {
        interest: seedWeight * semanticSeed.score,
        metadata: seedWeight * metadataSeed.metadata,
        support: seedWeight * supportSeed.support,
        supportMatch: {
          source: supportSeed.seed,
          kind: 'seed',
          contribution: seedWeight * supportSeed.support,
        },
        interestMatch: {
          source: semanticSeed.seed,
          kind: 'seed',
          contribution: seedWeight * semanticSeed.score,
        },
        metadataMatch: {
          source: metadataSeed.seed,
          kind: 'seed',
          contribution: seedWeight * metadataSeed.metadata,
        },
      };
      for (const [id, weight] of watchedWeights) {
        const interestContribution = weight * semantic.score(id, candidate.id);
        const pair = connection(id, candidate.id);
        const metadataContribution = weight * pair.metadata;
        const supportContribution = weight * pair.support;
        profile.support += supportContribution;
        if (supportContribution > profile.supportMatch.contribution) {
          profile.supportMatch = {
            source: sourceFor(id),
            kind: 'watched',
            contribution: supportContribution,
          };
        }
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

  let lookbackAnchors = seeds.map((seed) => seed.id);
  const lookbackMatch = (candidateId: string) =>
    lookbackAnchors
      .map((id) => ({ id, score: semantic.score(id, candidateId) }))
      .reduce((best, match) => (match.score > best.score ? match : best));

  return {
    prepareSource: semantic.prepareSource,
    async prepareLookback(
      olderCounts: ReadonlyMap<string, number>,
      random: Random,
    ) {
      lookbackAnchors = seeds.map((seed) => seed.id);
      const pending = [...olderCounts]
        .filter(
          ([id, count]) =>
            count > 0 && byId.has(id) && !lookbackAnchors.includes(id),
        )
        .sort(([a], [b]) => a.localeCompare(b));
      for (let n = 0; n < OlderAnchorLimit && pending.length > 0; n++) {
        let ticket = random.real(
          0,
          pending.reduce((sum, [, count]) => sum + count, 0),
          false,
        );
        let index = pending.length - 1;
        for (let i = 0; i < pending.length; i++) {
          ticket -= pending[i]![1];
          if (ticket < 0) {
            index = i;
            break;
          }
        }
        const [selected] = pending.splice(index, 1);
        lookbackAnchors.push(selected![0]);
        await semantic.prepareSource(selected![0]);
      }
    },
    score(candidateId: string, previousId?: string) {
      const profile = profileFor(candidateId);
      return {
        interestAffinity:
          ((1 - PreviousTitleShare) * profile.interest +
            PreviousTitleShare *
              (previousId ? semantic.score(previousId, candidateId) : 0)) *
          profile.support,
        metadataAffinity:
          ((1 - PreviousTitleShare) * profile.metadata +
            PreviousTitleShare *
              (previousId ? metadata.score(previousId, candidateId) : 0)) *
          profile.support,
        riskAffinity: profile.support,
        lookbackAffinity: lookbackMatch(candidateId).score,
      };
    },
    explain(
      candidateId: string,
      previousId: string | undefined,
      contributions: DiscoveryContributions,
    ) {
      const profile = profileFor(candidateId);
      const total =
        contributions.interest +
        contributions.metadata +
        contributions.risk +
        contributions.lookback;
      if (total <= 0)
        throw new Error(
          'Balanced explanation requires positive selection weight',
        );
      const percentage = (value: number) =>
        `${((100 * value) / total).toFixed(1)}%`;
      const reasons = [
        `This choice's weight: ${percentage(contributions.interest)} current interests, ${percentage(contributions.metadata)} broader metadata, ${percentage(contributions.risk)} connected exploration, ${percentage(contributions.lookback)} look-back.`,
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
            ...connection(match.source.id, candidateId).reasons.map(
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
        contributions.interest + contributions.metadata + contributions.risk >
        0
      ) {
        const match = profile.supportMatch;
        reasons.push(
          ...connection(match.source.id, candidateId).reasons.map(
            (reason) =>
              `Supporting connection from ${match.kind} title ${match.source.title}: ${reason}`,
          ),
        );
      }
      if (contributions.lookback > 0) {
        const match = lookbackMatch(candidateId);
        const kind = seeds.some((seed) => seed.id === match.id)
          ? 'original seed'
          : 'older watched';
        reasons.push(
          ...semantic
            .explain(match.id, candidateId)
            .map(
              (reason) =>
                `Look-back to ${kind} title ${sourceFor(match.id).title}: ${reason}`,
            ),
        );
      }
      return reasons;
    },
  };
}
