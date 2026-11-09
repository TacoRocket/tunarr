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
  const connections = (leftId: string, rightId: string) => {
    const left = metadata(leftId);
    const right = metadata(rightId);
    return METADATA_FIELDS.map(([field, , label]) => ({
      field,
      label,
      names: [...left[field]]
        .filter(([name]) => right[field].has(name))
        .map(([, displayName]) => displayName),
    })).filter(({ names }) => names.length > 0);
  };
  return {
    seedMatch(id: string) {
      const match = seedMatches.get(id);
      if (!match) throw new Error(`Missing seed-channel seed match for ${id}`);
      return match;
    },
    score(leftId: string, rightId: string) {
      return scoreMetadata(metadata(leftId), metadata(rightId));
    },
    connections,
    explain(leftId: string, rightId: string) {
      return connections(leftId, rightId).map(
        ({ label, names }) => `Shared ${label}: ${names.join(', ')}`,
      );
    },
  };
}

/**
 * Neighbours ranked by shared metadata, closest first. Balanced uses them in place
 * of similar titles while no similarity provider is ready, so its interests still
 * reach beyond the seeds themselves.
 */
export function metadataNeighbours(
  scorer: { score(leftId: string, rightId: string): number },
  catalog: SeedChannelSource[],
) {
  return {
    async similar(id: string, limit: number) {
      const ranked: { id: string; score: number }[] = [];
      for (const batch of chunk(catalog, SEED_SCORING_BATCH_SIZE)) {
        await throttle();
        for (const source of batch) {
          if (source.id === id) continue;
          const score = scorer.score(id, source.id);
          if (score > 0) ranked.push({ id: source.id, score });
        }
      }
      ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return ranked.slice(0, limit).map((match) => match.id);
    },
  };
}
