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
