import { expect, test } from 'vitest';
import type { SeedChannelSource } from '../MeilisearchService.ts';
import { createBalancedSeedChannelScorer } from './BalancedSeedChannelScorer.ts';
import { mixDiscoveryCandidates } from './SeedChannelDiscovery.ts';

const source = (id: string): SeedChannelSource => ({
  id,
  title: id,
  type: 'movie',
  originalReleaseYear: null,
});

test('an unwatched detour cannot admit its unrelated neighbors into current interests', async () => {
  const seed = source('baking');
  const detour = source('monster');
  const sequel = source('monster-sequel');
  const scorer = await createBalancedSeedChannelScorer(
    {
      getSimilarSeedChannelSources: async (id) =>
        id === detour.id ? [{ id: sequel.id, rank: 2 }] : [],
    },
    [seed, detour, sequel],
    [seed],
    [],
  );
  await scorer.prepareSource(detour.id);
  expect(scorer.score(sequel.id, detour.id).interestAffinity).toBe(0);
});

test('discovery does not bypass missing seed or watched evidence with uniform catalog weight', () => {
  const candidates = [
    { id: 'related', interest: 1, metadata: 1, risk: 1, lookback: 1 },
    { id: 'unrelated', interest: 0, metadata: 0, risk: 0, lookback: 0 },
  ];
  const mixed = mixDiscoveryCandidates(candidates, 25);
  expect(mixed.find((item) => item.id === 'unrelated')?.weight).toBe(0);
});
