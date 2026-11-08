import { chunk } from 'lodash-es';
import throttle from '../../util/throttle.ts';
import type { SimilarityProvider } from '../capabilities/contracts.ts';
import type { SeedChannelSource } from '../MeilisearchService.ts';
import { SEED_SCORING_BATCH_SIZE } from './SeedChannelScorer.ts';

/** Request-local reciprocal ranks from the similarity provider's neighbors. */
export async function createSemanticSeedChannelScorer(
  similarity: Pick<SimilarityProvider, 'similar'>,
  catalog: SeedChannelSource[],
  seeds: SeedChannelSource[],
) {
  const neighbors = new Map<string, Map<string, number>>();
  const prepareSource = async (id: string) => {
    if (neighbors.has(id)) return;
    const similar = await similarity.similar(id, 49);
    // The source is rank 1; its neighbors follow from rank 2.
    neighbors.set(
      id,
      new Map([[id, 1], ...similar.map((match, i) => [match, i + 2] as const)]),
    );
  };
  const ranksFor = (id: string) => {
    const ranks = neighbors.get(id);
    if (!ranks)
      throw new Error(`Semantic seed-channel source ${id} was not prepared`);
    return ranks;
  };
  const score = (leftId: string, rightId: string) => {
    const rank = ranksFor(leftId).get(rightId);
    return rank === undefined ? 0 : 1 / rank;
  };
  for (const seed of seeds) await prepareSource(seed.id);
  const seedMatches = new Map<
    string,
    { seed: SeedChannelSource; score: number }
  >();
  for (const batch of chunk(catalog, SEED_SCORING_BATCH_SIZE)) {
    await throttle();
    for (const source of batch) {
      let best: { seed: SeedChannelSource; score: number } | undefined;
      for (const seed of seeds) {
        const similarity = score(seed.id, source.id);
        if (!best || similarity > best.score)
          best = { seed, score: similarity };
      }
      if (!best) throw new Error('Seed-channel scoring requires a seed');
      seedMatches.set(source.id, best);
    }
  }
  return {
    prepareSource,
    seedMatch(id: string) {
      const match = seedMatches.get(id);
      if (!match) throw new Error(`Missing semantic seed match for ${id}`);
      return match;
    },
    score,
    explain(leftId: string, rightId: string) {
      const rank = ranksFor(leftId).get(rightId);
      if (rank === undefined) return [];
      return [
        leftId === rightId
          ? 'Same title (semantic rank 1).'
          : `Semantic neighbor (rank ${rank}).`,
      ];
    },
  };
}
