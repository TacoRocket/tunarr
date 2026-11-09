import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { manifestSchema } from './schema.ts';
import { extensionSimilarityProviders } from './similarity.ts';
import { ExtensionStore } from './store.ts';

vi.mock('./storeInstance.ts', () => ({ extensionStore: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// One installed similarity extension backed by a real store directory; its
// adapter calls are answered by `dispatch`.
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'similarity-'));
  roots.push(root);
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
  // Uninstalling removes the installation from the store's list.
  const installation = { uninstalled: false };
  vi.spyOn(store, 'installed').mockImplementation(async () =>
    installation.uninstalled ? [] : [{ ...state }],
  );
  vi.spyOn(store, 'manifest').mockResolvedValue(manifest);
  vi.spyOn(store, 'extensionDirectory').mockReturnValue(root);
  const dispatch = vi.spyOn(store, 'provide');
  const titles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i),
      text: 'title ' + i,
    }));
  return { store, state, installation, dispatch, titles };
}

it('finishes the current batch when disabled and resumes at the first unsent title', async () => {
  const { store, state, dispatch, titles } = await setup();
  dispatch.mockImplementation(async () => {
    // Settings queues its change on the same lock as the in-flight batch.
    void store.lock.runExclusive(() => {
      state.enabled = false;
    });
    return { indexed: 300 };
  });
  const [provider] = await extensionSimilarityProviders(store);
  const all = titles(301);
  expect(await provider!.index(all)).toEqual({ sent: 300, removed: 0 });
  expect(dispatch).toHaveBeenCalledTimes(1);

  state.enabled = true;
  dispatch.mockResolvedValue({ indexed: 1 });
  const [again] = await extensionSimilarityProviders(store);
  expect(await again!.index(all)).toEqual({ sent: 1, removed: 0 });
  expect(dispatch.mock.lastCall?.[2]).toMatchObject({ items: [all[300]] });
});

it('is preparing until Tunarr has sent it titles, then ready', async () => {
  const { store, dispatch, titles } = await setup();
  dispatch.mockResolvedValue({ indexed: 2 });
  const [provider] = await extensionSimilarityProviders(store);
  expect((await provider!.status()).state).toBe('preparing');
  await provider!.index(titles(2));
  expect(await provider!.status()).toEqual({
    state: 'ready',
    message: 'Similar is ready.',
  });
});

it('answers ids closest first, never the title asked about', async () => {
  const { store, dispatch } = await setup();
  dispatch.mockResolvedValue({
    matches: [
      { id: 'near', score: 0.9 },
      { id: 'seed', score: 1 },
      { id: 'middle', score: 0.5 },
      { id: 'far', score: 0.1 },
    ],
  });
  const [provider] = await extensionSimilarityProviders(store);
  expect(await provider!.similar('seed', 2)).toEqual(['near', 'middle']);
  // One extra is requested, so dropping the title itself still fills `limit`.
  expect(dispatch.mock.lastCall?.[2]).toMatchObject({ id: 'seed', k: 3 });
});

it('refuses to answer once the extension is turned off', async () => {
  const { store, state, dispatch } = await setup();
  const [provider] = await extensionSimilarityProviders(store);
  state.enabled = false;
  await expect(provider!.similar('seed', 5)).rejects.toThrow(
    'Similar is no longer available.',
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it('lists no provider for a disabled extension', async () => {
  const { store, state } = await setup();
  state.enabled = false;
  expect(await extensionSimilarityProviders(store)).toEqual([]);
});

it('stops before the next batch when the extension is uninstalled mid-run', async () => {
  const { store, installation, dispatch, titles } = await setup();
  dispatch.mockImplementation(async () => {
    // Settings queues the uninstall on the same lock as the in-flight batch.
    void store.lock.runExclusive(() => {
      installation.uninstalled = true;
    });
    return { indexed: 300 };
  });
  const [provider] = await extensionSimilarityProviders(store);
  expect(await provider!.index(titles(301))).toEqual({ sent: 300, removed: 0 });
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(provider!.similar('0', 5)).rejects.toThrow(
    'Similar is no longer available.',
  );
});
