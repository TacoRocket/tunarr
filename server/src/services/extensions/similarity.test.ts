import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { manifestSchema } from './schema.ts';
import { ExtensionSimilarity } from './similarity.ts';
import { ExtensionStore } from './store.ts';

vi.mock('./storeInstance.ts', () => ({ extensionStore: vi.fn() }));

it('finishes the current batch when disabled and resumes at the first unsent title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'similarity-disable-'));
  try {
    const store = new ExtensionStore(root, '', () => []);
    const manifest = manifestSchema.parse({
      id: 'similar',
      name: 'Similar',
      version: '1.0.0',
      apiVersion: '0.5',
      entrypoint: 'adapter.js',
      sha256: '1'.repeat(64),
      maintainer: 'Example',
      issueTracker: 'https://example.org/issues',
      provides: ['similarity'],
      actions: [{ id: 'status', label: 'Status' }],
    });
    const state = {
      key: 'example/packages:similar',
      id: manifest.id,
      repository: 'example/packages',
      source: 'https://github.com/example/packages',
      installed: true as const,
      commit: '1'.repeat(40),
      version: manifest.version,
      enabled: true,
      configured: true,
    };
    vi.spyOn(store, 'installed').mockImplementation(async () => [{ ...state }]);
    vi.spyOn(store, 'manifest').mockResolvedValue(manifest);
    vi.spyOn(store, 'extensionDirectory').mockReturnValue(root);
    const dispatch = vi.spyOn(store, 'provide').mockImplementation(async () => {
      // Settings queues its change on the same lock as the in-flight batch.
      void store.lock.runExclusive(() => {
        state.enabled = false;
      });
      return { indexed: 300 };
    });
    const service = new ExtensionSimilarity(store);
    const titles = Array.from({ length: 301 }, (_, i) => ({
      id: String(i),
      text: 'title ' + i,
    }));
    expect(await service.index(titles)).toEqual({ sent: 300, removed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);

    state.enabled = true;
    dispatch.mockResolvedValue({ indexed: 1 });
    expect(await service.index(titles)).toEqual({ sent: 1, removed: 0 });
    expect(dispatch.mock.lastCall?.[2]).toMatchObject({ items: [titles[300]] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
