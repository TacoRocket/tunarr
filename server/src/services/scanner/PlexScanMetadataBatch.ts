import type { Result } from '../../types/result.ts';

// Experimental scan-only batching. The original summary objects still reach the
// scanner so failed detail requests retain its existing seen/missing semantics.
export class PlexScanMetadataBatch<T extends { externalId: string }> {
  private readonly results = new WeakMap<T, Result<T>>();

  take(item: T): Result<T> | undefined {
    const result = this.results.get(item);
    this.results.delete(item);
    return result;
  }

  async *iterate(
    source: AsyncIterable<T>,
    fetchBatch: (keys: string[]) => Promise<Map<string, Result<T>>>,
    canceled: () => boolean,
    pathFilter?: string,
    needsDetails: (item: T) => boolean = () => true,
  ): AsyncGenerator<T> {
    const configured = Number(
      process.env.TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE ?? 1,
    );
    const batchSize =
      Number.isInteger(configured) && configured > 1
        ? Math.min(configured, 100)
        : 1;
    if (batchSize === 1) {
      yield* source;
      return;
    }
    let pending: T[] = [];
    const emit = async function* (self: PlexScanMetadataBatch<T>, items: T[]) {
      if (canceled())
        throw new Error('Plex scan canceled before metadata batch completed');
      const keys = items
        .filter(
          (item) =>
            (!pathFilter || item.externalId === pathFilter) &&
            needsDetails(item),
        )
        .map((item) => item.externalId);
      const results =
        keys.length > 0 ? await fetchBatch(keys) : new Map<string, Result<T>>();
      for (const item of items) {
        if (canceled())
          throw new Error('Plex scan canceled before metadata batch completed');
        const result = results.get(item.externalId);
        if (result) self.results.set(item, result);
        yield item;
      }
    };
    for await (const item of source) {
      if (canceled())
        throw new Error('Plex scan canceled before metadata batch completed');
      pending.push(item);
      if (pending.length === batchSize) {
        yield* emit(this, pending);
        pending = [];
      }
    }
    if (pending.length > 0) yield* emit(this, pending);
  }
}
