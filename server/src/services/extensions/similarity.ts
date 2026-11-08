import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { similarityIndexResult, similarityQueryResult } from './schema.ts';
import type { ExtensionStore } from './store.ts';
import { extensionStore } from './storeInstance.ts';

// Items go to the provider in batches small enough to finish well inside one
// 30-second run, even on a slow machine.
const batchSize = 300;

export type SimilarityItem = { id: string; text: string };

const Tracking = z.object({
  provider: z.string(),
  items: z.record(z.string(), z.string()),
});

const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The text a provider indexes for a title: name, genres, tags, summary. */
export function similarityText(doc: {
  title: string;
  genres?: { name: string }[] | string[] | null;
  tags?: string[] | null;
  summary?: string | null;
  plot?: string | null;
}) {
  const names = (list: unknown[] | null | undefined) =>
    (list ?? [])
      .map((x) => (typeof x === 'string' ? x : (x as { name?: string }).name))
      .filter(Boolean)
      .join(', ');
  return [
    doc.title,
    names(doc.genres),
    names(doc.tags),
    (doc.summary || doc.plot || '').trim(),
  ]
    .filter(Boolean)
    .join('. ');
}

/**
 * Tunarr's side of the similarity hook. Tunarr keeps a small list of what it
 * has sent (id and a text hash) next to the extension, so each pass sends only
 * new, changed and removed titles. The provider owns the index itself.
 */
export class ExtensionSimilarity {
  constructor(private readonly store: ExtensionStore = extensionStore()) {}

  private async provider() {
    return this.store.lock.runExclusive(async () => {
      await this.store.prepare();
      return this.store.provider('similarity');
    });
  }

  private trackingPath(dir: string) {
    return join(dir, 'similarity-index.json');
  }

  private async readTracking(dir: string, provider: string) {
    try {
      const saved = Tracking.parse(
        JSON.parse(await readFile(this.trackingPath(dir), 'utf8')),
      );
      // A new provider version may index differently: start over.
      return saved.provider === provider ? saved.items : {};
    } catch {
      return {};
    }
  }

  private async writeTracking(
    dir: string,
    provider: string,
    items: Record<string, string>,
  ) {
    const path = this.trackingPath(dir);
    await writeFile(path + '.tmp', JSON.stringify({ provider, items }), {
      mode: 0o600,
    });
    await rename(path + '.tmp', path);
  }

  /** True when an enabled similarity extension is installed. */
  async hasProvider() {
    return (await this.provider()) !== undefined;
  }

  /** True when a provider is installed and has indexed something. */
  async available() {
    const found = await this.provider();
    if (!found) return false;
    const dir = this.store.extensionDirectory(found.state);
    const tracked = await this.readTracking(
      dir,
      `${found.state.key}@${found.state.version}`,
    );
    return Object.keys(tracked).length > 0;
  }

  /** Sends new and changed titles to the provider, and removals. */
  async index(items: SimilarityItem[]) {
    const found = await this.provider();
    if (!found) return { sent: 0, removed: 0 };
    const { state, manifest } = found;
    const dir = this.store.extensionDirectory(state);
    const providerId = `${state.key}@${state.version}`;
    const tracked = await this.readTracking(dir, providerId);
    const current = new Map(items.map((i) => [i.id, i]));
    const changed = items.filter((i) => tracked[i.id] !== hash(i.text));
    const removed = Object.keys(tracked).filter((id) => !current.has(id));
    const call = (payload: Record<string, unknown>) =>
      this.store.lock.runExclusive(() =>
        this.store.provide(state, manifest, payload, similarityIndexResult),
      );
    for (let i = 0; i < removed.length; i += 1000) {
      const ids = removed.slice(i, i + 1000);
      await call({ action: 'similarity.index', items: [], removed: ids });
      for (const id of ids) delete tracked[id];
      await this.writeTracking(dir, providerId, tracked);
    }
    for (let i = 0; i < changed.length; i += batchSize) {
      const batch = changed.slice(i, i + batchSize);
      await call({ action: 'similarity.index', items: batch, removed: [] });
      for (const item of batch) tracked[item.id] = hash(item.text);
      // Saved after every batch, so an interrupted pass resumes where it was.
      await this.writeTracking(dir, providerId, tracked);
    }
    return { sent: changed.length, removed: removed.length };
  }

  /** Nearest titles to `id`, ranked 1 = closest. */
  async similar(id: string, limit = 49) {
    const found = await this.provider();
    if (!found) throw new Error('No similarity extension is installed.');
    const { matches } = await this.store.lock.runExclusive(() =>
      this.store.provide(
        found.state,
        found.manifest,
        { action: 'similarity.query', id, k: limit + 1 },
        similarityQueryResult,
      ),
    );
    return matches
      .filter((m) => m.id !== id)
      .slice(0, limit)
      .map((m, i) => ({ id: m.id, rank: i + 1 }));
  }
}

let shared: ExtensionSimilarity | undefined;
export const extensionSimilarity = () => (shared ??= new ExtensionSimilarity());
