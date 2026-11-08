import { chunk } from 'lodash-es';
import type { Random } from 'random-js';
import throttle from '../../util/throttle.ts';
import type { SimilarityProvider } from '../capabilities/contracts.ts';
import type { SeedChannelSource } from '../MeilisearchService.ts';
import type { BalancedHistoryPlay } from './BalancedSeedChannelHistory.ts';
import {
  createSeedChannelScorer,
  SEED_SCORING_BATCH_SIZE,
} from './SeedChannelScorer.ts';
import type { DiscoveryContributions } from './SeedChannelDiscovery.ts';
import { createSemanticSeedChannelScorer } from './SemanticSeedChannelScorer.ts';

const AdaptationRate = 0.25;
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

/** Reconstruct current interests from seeds and recorded starts only. */
export async function createBalancedSeedChannelScorer(
  similarity: Pick<SimilarityProvider, 'similar'>,
  catalog: SeedChannelSource[],
  seeds: SeedChannelSource[],
  watchedPlays: readonly BalancedHistoryPlay[],
  metadataScorer?: Awaited<ReturnType<typeof createSeedChannelScorer>>,
) {
  const metadata =
    metadataScorer ?? (await createSeedChannelScorer(catalog, seeds));
  const semantic = await createSemanticSeedChannelScorer(
    similarity,
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

  const seedIds = new Set(seeds.map(({ id }) => id));
  const watchedSelfCaps = new Map<
    string,
    { interest: number; metadata: number }
  >();
  const prepareWatchedSource = async (id: string) => {
    await semantic.prepareSource(id);
    if (seedIds.has(id) || watchedSelfCaps.has(id)) return;
    const cap = { interest: 0, metadata: 0 };
    for (const batch of chunk(catalog, SEED_SCORING_BATCH_SIZE)) {
      await throttle();
      for (const candidate of batch) {
        if (candidate.id === id) continue;
        const pair = connection(id, candidate.id);
        cap.interest = Math.max(
          cap.interest,
          semantic.score(id, candidate.id) * pair.support,
        );
        cap.metadata = Math.max(cap.metadata, pair.metadata * pair.support);
      }
    }
    watchedSelfCaps.set(id, cap);
  };
  const watchedInterest = (id: string, candidateId: string) => {
    const score = semantic.score(id, candidateId);
    const cap = watchedSelfCaps.get(id);
    return id === candidateId && cap ? Math.min(score, cap.interest) : score;
  };

  // Equal source IDs share one retrieval. Each start still gets its own decay
  // coefficient, including repeat plays; history is not reduced to play counts.
  const watchedWeights = new Map<string, number>();
  let seedWeight = 1;
  for (let index = watchedPlays.length - 1; index >= 0; index--) {
    if (index % SEED_SCORING_BATCH_SIZE === 0) await throttle();
    const { sourceId: id, weight } = watchedPlays[index]!;
    const rate = AdaptationRate * weight;
    const contribution = rate * seedWeight;
    if (contribution > 0) {
      sourceFor(id);
      watchedWeights.set(id, (watchedWeights.get(id) ?? 0) + contribution);
    }
    seedWeight *= 1 - rate;
  }
  for (const id of watchedWeights.keys()) await prepareWatchedSource(id);

  const profiles = new Map<string, CandidateProfile>();
  for (const batch of chunk(catalog, SEED_SCORING_BATCH_SIZE)) {
    await throttle();
    for (const candidate of batch) {
      const semanticSeed = semantic.seedMatch(candidate.id);
      const seedConnections = seeds.map((seed) => {
        const pair = connection(seed.id, candidate.id);
        return {
          seed,
          support: pair.support,
          metadata: pair.metadata * pair.support,
        };
      });
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
        const pair = connection(id, candidate.id);
        const interestContribution =
          weight * watchedInterest(id, candidate.id) * pair.support;
        const selfCap =
          id === candidate.id ? watchedSelfCaps.get(id) : undefined;
        const supportedMetadata = pair.metadata * pair.support;
        const metadataContribution =
          weight *
          (selfCap
            ? Math.min(supportedMetadata, selfCap.metadata)
            : supportedMetadata);
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

  const seedAnchors = seeds.map(({ id }) => ({ id, strength: 1 }));
  let lookbackAnchors = [...seedAnchors];
  const lookbackMatch = (candidateId: string) =>
    lookbackAnchors
      .map(({ id, strength }) => ({
        id,
        score: strength * watchedInterest(id, candidateId),
      }))
      .reduce((best, match) => (match.score > best.score ? match : best));

  return {
    async prepareLookback(
      olderCounts: ReadonlyMap<string, number>,
      random: Random,
    ) {
      lookbackAnchors = [...seedAnchors];
      const pending = [...olderCounts]
        .filter(([id, count]) => count > 0 && byId.has(id) && !seedIds.has(id))
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
        lookbackAnchors.push({
          id: selected![0],
          strength: Math.min(1, selected![1]),
        });
        await prepareWatchedSource(selected![0]);
      }
    },
    score(candidateId: string) {
      const profile = profileFor(candidateId);
      return {
        interestAffinity: profile.interest,
        metadataAffinity: profile.metadata,
        riskAffinity: profile.support,
        lookbackAffinity: lookbackMatch(candidateId).score,
      };
    },
    explain(candidateId: string, contributions: DiscoveryContributions) {
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
      if (watchedSelfCaps.has(candidateId)) {
        reasons.push(
          'Self-match from recorded viewing is capped at the strongest other catalog match; Familiarity applies separately.',
        );
      }
      return reasons;
    },
  };
}
