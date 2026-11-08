import { expect, test } from 'vitest';
import type { SeedChannelSource } from '../MeilisearchService.ts';
import { createSemanticSeedChannelScorer } from './SemanticSeedChannelScorer.ts';

const source = (id: string): SeedChannelSource => ({
  id,
  title: id,
  type: 'movie',
  originalReleaseYear: null,
});

test("the provider's closest title ranks second, after the seed itself", async () => {
  const seed = source('space-western');
  const near = source('frontier-saga');
  const far = source('cowboy-drama');
  const scorer = await createSemanticSeedChannelScorer(
    { similar: async () => [near.id, far.id] },
    [seed, near, far],
    [seed],
  );
  expect(scorer.score(seed.id, seed.id)).toBe(1);
  expect(scorer.score(seed.id, near.id)).toBe(1 / 2);
  expect(scorer.score(seed.id, far.id)).toBe(1 / 3);
  expect(scorer.explain(seed.id, near.id)).toEqual([
    'Semantic neighbor (rank 2).',
  ]);
});
