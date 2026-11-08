import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type {
  SimilarityItem,
  SimilarityProvider,
} from '../capabilities/contracts.ts';
import {
  similarityIndexResult,
  similarityQueryResult,
  type Installation,
  type Manifest,
} from './schema.ts';
import type { ExtensionStore } from './store.ts';
import { extensionStore } from './storeInstance.ts';

// Items go to the provider in batches small enough to finish well inside one
// 30-second run, even on a slow machine.
const batchSize = 300;

const Tracking = z.object({
  provider: z.string(),
  items: z.record(z.string(), z.string()),
});

const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Each enabled, set-up extension that provides similarity, as a provider. */
export async function extensionSimilarityProviders(
  store: ExtensionStore = extensionStore(),
): Promise<SimilarityProvider[]> {
  const found = await store.discoverProviders('similarity');
  return found.map(({ state, manifest }) =>
    extensionSimilarityProvider(store, state, manifest),
  );
}

/** One installed extension as a similarity provider, whatever its state. */
export function extensionSimilarityProvider(
  store: ExtensionStore,
  state: Installation,
  manifest: Manifest,
): SimilarityProvider {
  return new ExtensionSimilarityProvider(store, state, manifest);
}

/**
 * One extension answering the similarity capability. Tunarr keeps a small list
 * of what it has sent (id and a text hash) next to the extension, so each pass
 * sends only new, changed and removed titles. The extension owns the index.
 */
class ExtensionSimilarityProvider implements SimilarityProvider {
  readonly name: string;
  private readonly dir: string;
  private readonly trackingId: string;

  constructor(
    private readonly store: ExtensionStore,
    private readonly state: Installation,
    manifest: Manifest,
  ) {
    this.name = manifest.name;
    this.dir = store.extensionDirectory(state);
    this.trackingId = `${state.key}@${state.version}`;
  }

  private get trackingPath() {
    return join(this.dir, 'similarity-index.json');
  }

  private async readTracking() {
    try {
      const saved = Tracking.parse(
        JSON.parse(await readFile(this.trackingPath, 'utf8')),
      );
      // A new provider version may index differently: start over.
      return saved.provider === this.trackingId ? saved.items : {};
    } catch {
      return {};
    }
  }

  private async writeTracking(items: Record<string, string>) {
    await writeFile(
      this.trackingPath + '.tmp',
      JSON.stringify({ provider: this.trackingId, items }),
      { mode: 0o600 },
    );
    await rename(this.trackingPath + '.tmp', this.trackingPath);
  }

  async status() {
    const titles = Object.keys(await this.readTracking()).length;
    return titles > 0
      ? { state: 'ready' as const, message: `${this.name} is ready.` }
      : {
          state: 'preparing' as const,
          message: `${this.name} hasn't indexed your library yet. Tunarr sends it your shows and movies within the hour.`,
        };
  }

  async index(items: SimilarityItem[]) {
    const tracked = await this.readTracking();
    const current = new Map(items.map((i) => [i.id, i]));
    const changed = items.filter((i) => tracked[i.id] !== hash(i.text));
    const removed = Object.keys(tracked).filter((id) => !current.has(id));
    const processed = { sent: 0, removed: 0 };
    const indexBatch = (batch: SimilarityItem[], ids: string[]) =>
      this.store.lock.runExclusive(async () => {
        // Settings may disable, uninstall or update the provider between batches.
        const active = await this.store.currentProvider(
          'similarity',
          this.state,
        );
        if (!active) return false;
        await this.store.provide(
          active.state,
          active.manifest,
          { action: 'similarity.index', items: batch, removed: ids },
          similarityIndexResult,
        );
        for (const id of ids) delete tracked[id];
        for (const item of batch) tracked[item.id] = hash(item.text);
        await this.writeTracking(tracked);
        processed.sent += batch.length;
        processed.removed += ids.length;
        return true;
      });
    for (let i = 0; i < removed.length; i += 1000) {
      if (!(await indexBatch([], removed.slice(i, i + 1000)))) return processed;
    }
    for (let i = 0; i < changed.length; i += batchSize) {
      if (!(await indexBatch(changed.slice(i, i + batchSize), [])))
        return processed;
    }
    return processed;
  }

  async similar(id: string, limit: number) {
    const { matches } = await this.store.lock.runExclusive(async () => {
      const active = await this.store.currentProvider('similarity', this.state);
      if (!active) throw new Error(`${this.name} is no longer available.`);
      return this.store.provide(
        active.state,
        active.manifest,
        { action: 'similarity.query', id, k: limit + 1 },
        similarityQueryResult,
      );
    });
    return matches
      .map((m) => m.id)
      .filter((match) => match !== id)
      .slice(0, limit);
  }
}
