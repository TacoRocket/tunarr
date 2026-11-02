import { chunk } from 'lodash-es';
import throttle from '../../util/throttle.ts';
import type { SeedChannelSource } from '../MeilisearchService.ts';

const METADATA_FIELDS = [
  ['genres', 4, 'genre'],
  ['tags', 6, 'tag'],
  ['actors', 2, 'cast'],
  ['director', 3, 'director'],
  ['studio', 1, 'studio'],
] as const;

export const SEED_SCORING_BATCH_SIZE = 100;

type MetadataField = (typeof METADATA_FIELDS)[number][0];
type NormalizedMetadata = Record<MetadataField, Map<string, string>>;

function normalizeNames(values: readonly (string | { name: string })[] = []) {
  return new Map(
    values
      .map((value) => {
        const name = typeof value === 'string' ? value : value.name;
        return [name.trim().toLowerCase(), name] as const;
      })
      .filter(([name]) => name.length > 0),
  );
}

function normalize(source: SeedChannelSource): NormalizedMetadata {
  return {
    genres: normalizeNames(source.genres),
    tags: normalizeNames(source.tags),
    actors: normalizeNames(source.actors),
    director: normalizeNames(source.director),
    studio: normalizeNames(source.studio),
  };
}

function scoreMetadata(left: NormalizedMetadata, right: NormalizedMetadata) {
  let score = 0;
  for (const [field, importance] of METADATA_FIELDS) {
    const a = left[field];
    const b = right[field];
    let shared = 0;
    for (const name of a.keys()) {
      if (b.has(name)) shared++;
    }
    if (shared > 0) {
      score += (importance * shared) / (a.size + b.size - shared);
    }
  }
  return score;
}

/** Request-local weighted Jaccard metadata and best-seed scores. */
export async function createSeedChannelScorer(
  catalog: SeedChannelSource[],
  seeds: SeedChannelSource[],
) {
  const normalized = new Map<string, NormalizedMetadata>();
  const batches = chunk(catalog, SEED_SCORING_BATCH_SIZE);
  for (const batch of batches) {
    await throttle();
    for (const source of batch) normalized.set(source.id, normalize(source));
  }
  const metadata = (id: string) => {
    const value = normalized.get(id);
    if (!value) throw new Error(`Missing seed-channel metadata for ${id}`);
    return value;
  };
  const seedMatches = new Map<
    string,
    { seed: SeedChannelSource; score: number }
  >();
  for (const batch of batches) {
    await throttle();
    for (const source of batch) {
      let best: { seed: SeedChannelSource; score: number } | undefined;
      for (const seed of seeds) {
        const score = scoreMetadata(metadata(seed.id), metadata(source.id));
        // Preserve the first seed on ties, as the original stable sort did.
        if (!best || score > best.score) best = { seed, score };
      }
      if (!best) throw new Error('Seed-channel scoring requires a seed');
      seedMatches.set(source.id, best);
    }
  }
  return {
    seedMatch(id: string) {
      const match = seedMatches.get(id);
      if (!match) throw new Error(`Missing seed-channel seed match for ${id}`);
      return match;
    },
    score(leftId: string, rightId: string) {
      return scoreMetadata(metadata(leftId), metadata(rightId));
    },
    explain(leftId: string, rightId: string) {
      const left = metadata(leftId);
      const right = metadata(rightId);
      const reasons: string[] = [];
      for (const [field, , label] of METADATA_FIELDS) {
        const shared: string[] = [];
        for (const [name, displayName] of left[field]) {
          if (right[field].has(name)) shared.push(displayName);
        }
        if (shared.length > 0) {
          reasons.push(`Shared ${label}: ${shared.join(', ')}`);
        }
      }
      return reasons;
    },
  };
}
