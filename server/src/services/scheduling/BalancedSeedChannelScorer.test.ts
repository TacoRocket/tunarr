import { MersenneTwister19937, Random } from 'random-js';
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
  expect(scorer.score(sequel.id).interestAffinity).toBe(0);
});

test('discovery does not bypass missing seed or watched evidence with uniform catalog weight', () => {
  const candidates = [
    { id: 'related', interest: 1, metadata: 1, risk: 1, lookback: 1 },
    { id: 'unrelated', interest: 0, metadata: 0, risk: 0, lookback: 0 },
  ];
  const mixed = mixDiscoveryCandidates(candidates, 25);
  expect(mixed.find((item) => item.id === 'unrelated')?.weight).toBe(0);
});

test('one recorded start contributes one quarter of its supported relationship', async () => {
  const seed = { ...source('food'), genres: ['Food'] };
  const food = { ...source('other-food'), genres: ['Food'] };
  const watched = {
    ...source('crime'),
    genres: ['Crime'],
    actors: ['Solo actor'],
  };
  const crime = { ...source('other-crime'), genres: ['Crime'] };
  const scorer = await createBalancedSeedChannelScorer(
    {
      getSimilarSeedChannelSources: async (id) =>
        id === seed.id
          ? [{ id: food.id, rank: 2 }]
          : [{ id: crime.id, rank: 2 }],
    },
    [seed, food, watched, crime],
    [seed],
    [watched.id],
  );
  expect(scorer.score(food.id).interestAffinity).toBe(0.75 * 0.5);
  expect(scorer.score(crime.id).interestAffinity).toBe(0.25 * 0.5);
  expect(scorer.score(food.id).metadataAffinity).toBe(0.75 * 6);
  expect(scorer.score(crime.id).metadataAffinity).toBe(0.25 * 6);
  expect(scorer.score(watched.id).interestAffinity).toBe(
    scorer.score(crime.id).interestAffinity,
  );
  expect(scorer.score(watched.id).metadataAffinity).toBe(
    scorer.score(crime.id).metadataAffinity,
  );
  expect(scorer.score(seed.id).interestAffinity).toBe(0.75);
});

test('older watched self-matches are capped without capping explicit seeds', async () => {
  const seed = source('seed');
  const watched = source('older');
  const neighbor = source('neighbor');
  const scorer = await createBalancedSeedChannelScorer(
    {
      getSimilarSeedChannelSources: async (id) =>
        id === watched.id ? [{ id: neighbor.id, rank: 2 }] : [],
    },
    [seed, watched, neighbor],
    [seed],
    [],
  );
  await scorer.prepareLookback(
    new Map([[watched.id, 5]]),
    new Random(MersenneTwister19937.seed(1)),
  );
  expect(scorer.score(watched.id).lookbackAffinity).toBe(0.5);
  expect(scorer.score(neighbor.id).lookbackAffinity).toBe(0.5);
  expect(scorer.score(seed.id).lookbackAffinity).toBe(1);
});
