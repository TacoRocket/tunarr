import { afterEach, expect, it, vi } from 'vitest';
import { Result } from '../../types/result.ts';
import { PlexScanMetadataBatch } from './PlexScanMetadataBatch.ts';

afterEach(() => vi.unstubAllEnvs());

it('reduces full-detail requests while preserving listing order and detail contents', async () => {
  const items = Array.from({ length: 45 }, (_, i) => ({
    externalId: String(i),
  }));
  const details = items.map((item) => ({
    ...item,
    title: `Title ${item.externalId}`,
  }));
  const outputs = [];

  for (const size of ['1', '20']) {
    vi.stubEnv('TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE', size);
    const batch = new PlexScanMetadataBatch<(typeof items)[number]>();
    const individual = vi.fn(async (id: string) =>
      Result.success(details[Number(id)]),
    );
    const grouped = vi.fn(
      async (ids: string[]) =>
        new Map(
          [...ids]
            .reverse()
            .map((id) => [id, Result.success(details[Number(id)])]),
        ),
    );
    async function* listing() {
      yield* items;
    }
    const output = [];
    let index = 0;
    for await (const item of batch.iterate(listing(), grouped, () => false)) {
      expect(item).toBe(items[index++]);
      output.push(
        (await (batch.take(item) ?? individual(item.externalId))).get(),
      );
    }
    outputs.push(output);
    expect(individual).toHaveBeenCalledTimes(size === '1' ? 45 : 0);
    expect(grouped.mock.calls.map(([ids]) => ids.length)).toEqual(
      size === '1' ? [] : [20, 20, 5],
    );
  }
  expect(outputs[0]).toEqual(details);
  expect(outputs[1]).toEqual(outputs[0]);
});

it('excludes an already refreshed item from the eager detail batch but still yields it for missing-item detection', async () => {
  vi.stubEnv('TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE', '20');
  const covered = { externalId: '10' };
  const uncovered = { externalId: '11' };
  const batch = new PlexScanMetadataBatch<typeof covered>();
  const fetchBatch = vi.fn(
    async () => new Map([[uncovered.externalId, Result.success(uncovered)]]),
  );
  async function* listing() {
    yield covered;
    yield uncovered;
  }
  const output = [];
  for await (const item of batch.iterate(
    listing(),
    fetchBatch,
    () => false,
    undefined,
    (item) => item !== covered,
  ))
    output.push(item);
  expect(fetchBatch).toHaveBeenCalledExactlyOnceWith(['11']);
  expect(output).toEqual([covered, uncovered]);
  expect(batch.take(covered)).toBeUndefined();
  expect(batch.take(uncovered)?.get()).toBe(uncovered);
});
