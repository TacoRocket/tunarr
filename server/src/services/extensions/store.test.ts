import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { capabilityTable, consult } from '../capabilities/capabilities.ts';
import { providedCapabilities } from './providedCapabilities.ts';
import { runExtension } from './runtime.ts';
import { extensionSimilarityProviders } from './similarity.ts';
import { ExtensionStore } from './store.ts';
import { extensionStore } from './storeInstance.ts';

vi.mock('./runtime.ts', () => ({ runExtension: vi.fn() }));
// Capability lookups use the shared store; point it at this test's store.
vi.mock('./storeInstance.ts', () => ({ extensionStore: vi.fn() }));

const repository = 'example/packages';
const source = 'https://github.com/' + repository;
const key = repository + ':sample';
const first = { version: '1.0.0', commit: '1'.repeat(40) };
const next = { version: '1.0.1', commit: '2'.repeat(40) };
const settings = { address: 'https://media.example', apiKey: 'fixture-key' };
const files = new Map<string, string>();
// A second, unrelated extension from another repository in the same source.
const otherRepository = 'example/other';
const otherKey = otherRepository + ':other';
const other = { version: '1.0.0', commit: '3'.repeat(40) };
const otherFiles = new Map<string, string>();
const adapter = (version: string) =>
  `function run() { return { message: "${version}" }; }`;

let root: string;
let store: ExtensionStore;
async function openStore() {
  const instance = new ExtensionStore(root, source, () => []);
  await instance.prepare();
  return instance;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'extension-store-'));
  const listing = {
    id: 'sample',
    name: 'Sample',
    description: '',
    repository,
    ...first,
  };
  const otherListing = {
    id: 'other',
    name: 'Other',
    description: '',
    repository: otherRepository,
    ...other,
  };
  files.set(
    'HEAD/source-v0.json',
    JSON.stringify({ schemaVersion: 1, extensions: [listing, otherListing] }),
  );
  const otherCode = adapter(other.version);
  otherFiles.set(other.commit + '/adapter.js', otherCode);
  otherFiles.set(
    other.commit + '/tunarr-extension.json',
    JSON.stringify({
      id: 'other',
      name: 'Other',
      version: other.version,
      apiVersion: '0.5',
      entrypoint: 'adapter.js',
      sha256: createHash('sha256').update(otherCode).digest('hex'),
      maintainer: 'Example',
      issueTracker: 'https://github.com/' + otherRepository + '/issues',
      settings: [{ key: 'note', type: 'text', label: 'Note' }],
      actions: [{ id: 'lookup', label: 'Look up' }],
    }),
  );
  files.set(
    'HEAD/feed-v0.json',
    JSON.stringify({ id: 'sample', latest: next }),
  );
  for (const { version, commit } of [first, next]) {
    const code = adapter(version);
    files.set(commit + '/adapter.js', code);
    files.set(
      commit + '/tunarr-extension.json',
      JSON.stringify({
        id: 'sample',
        name: 'Sample',
        version,
        apiVersion: '0.5',
        entrypoint: 'adapter.js',
        sha256: createHash('sha256').update(code).digest('hex'),
        maintainer: 'Example',
        issueTracker: source + '/issues',
        settings: [
          { key: 'address', type: 'url', label: 'Address' },
          { key: 'apiKey', type: 'secret', label: 'Key' },
        ],
        actions: [{ id: 'lookup', label: 'Look up' }],
        // Lets the lifecycle tests follow a capability and stored data.
        provides: ['similarity'],
        storageMiB: 1,
      }),
    );
  }
  vi.stubGlobal('fetch', async (url: string) => {
    const served = (repo: string, from: Map<string, string>) => {
      const prefix = 'https://raw.githubusercontent.com/' + repo + '/';
      return url.startsWith(prefix)
        ? from.get(url.slice(prefix.length))
        : undefined;
    };
    const body =
      served(repository, files) ?? served(otherRepository, otherFiles);
    return new Response(body, { status: body === undefined ? 404 : 200 });
  });
  store = await openStore();
  await store.install({
    source,
    repository,
    id: 'sample',
    commit: first.commit,
  });
  await store.configure(key, settings, true);
  vi.mocked(extensionStore).mockImplementation(() => store);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  files.clear();
  otherFiles.clear();
  await rm(root, { recursive: true, force: true });
});

it('keeps the installed release active until a verified update and retains its settings', async () => {
  await store.checkUpdate(key);
  expect(await store.state(key)).toMatchObject({
    ...first,
    enabled: true,
    update: next,
  });

  files.set(next.commit + '/adapter.js', 'incomplete download');
  await expect(store.update(key, next.commit)).rejects.toMatchObject({
    status: 422,
  });
  store = await openStore();
  expect(await store.state(key)).toMatchObject({ ...first, enabled: true });
  expect(await store.settings(await store.state(key))).toEqual(settings);

  vi.mocked(runExtension).mockResolvedValueOnce({
    value: { message: 'Found' },
  });
  await store.act(key, { action: 'lookup' }, vi.fn());
  expect(vi.mocked(runExtension).mock.calls[0]?.[1]).toBe(
    adapter(first.version),
  );

  files.set(next.commit + '/adapter.js', adapter(next.version));
  await store.update(key, next.commit);
  store = await openStore();
  const updated = await store.state(key);
  expect(updated).toMatchObject({
    ...next,
    enabled: true,
    configured: true,
    update: null,
  });
  expect(await store.settings(updated)).toEqual(settings);
});

it('rejects stale actions immediately and keeps a disabled extension disabled through update and restart', async () => {
  const staleAction = { action: 'lookup' };
  await store.toggle(key, false);
  await expect(store.act(key, staleAction, vi.fn())).rejects.toMatchObject({
    status: 409,
    message: 'This extension is disabled.',
  });
  await store.checkUpdate(key);
  await store.update(key, next.commit);
  store = await openStore();
  await expect(store.act(key, staleAction, vi.fn())).rejects.toMatchObject({
    status: 409,
  });
  expect(runExtension).not.toHaveBeenCalled();

  await store.toggle(key, true);
  vi.mocked(runExtension).mockResolvedValueOnce({
    value: { message: 'Found' },
  });
  expect(await store.act(key, staleAction, vi.fn())).toMatchObject({
    version: next.version,
    result: { message: 'Found' },
  });
  expect(vi.mocked(runExtension).mock.calls[0]?.[1]).toBe(
    adapter(next.version),
  );
});

it('preserves listing visibility across source refresh and restart independently of the installation', async () => {
  await store.setHidden(key, true);
  await store.changeSource(source);
  store = await openStore();
  expect(await store.hiddenListings()).toEqual([key]);
  expect(await store.installed()).toMatchObject([{ key, enabled: true }]);
  await store.setHidden(key, false);
  expect(await (await openStore()).hiddenListings()).toEqual([]);
});

// Tunarr hands the extension one title, so it counts as having indexed.
async function indexOneTitle() {
  vi.mocked(runExtension).mockResolvedValueOnce({ value: { indexed: 1 } });
  const [provider] = await extensionSimilarityProviders(store);
  await provider!.index([{ id: 'title-1', text: 'A space western' }]);
}

// What the Info tab shows for the extension's similarity capability.
async function similarityShown() {
  const state = await store.state(key);
  const [shown] = await providedCapabilities(
    store,
    state,
    await store.manifest(state),
  );
  return shown?.state;
}

// The extension saves a value and a file in its own storage.
async function storeSomething() {
  vi.mocked(runExtension).mockResolvedValueOnce({
    value: { message: 'Saved' },
    writes: {
      kv: { note: 'kept' },
      files: [['cache.bin', new Uint8Array([1, 2, 3]).buffer]],
    },
  });
  await store.act(key, { action: 'lookup' }, vi.fn());
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

it('turning an extension off follows through everywhere it is used, and on again picks up where it was', async () => {
  await indexOneTitle();
  expect(await similarityShown()).toBe('ready');
  expect((await consult('similarity')).provider).toBeDefined();

  await store.toggle(key, false);
  await expect(
    store.act(key, { action: 'lookup' }, vi.fn()),
  ).rejects.toMatchObject({ status: 409 });
  expect(await extensionSimilarityProviders(store)).toEqual([]);
  expect(await similarityShown()).toBe('off');
  // What Semantic and Balanced seed channels are told while they fall back.
  expect((await consult('similarity')).status.message).toBe(
    capabilityTable.similarity.whenMissing,
  );

  await store.toggle(key, true);
  expect(await store.settings(await store.state(key))).toEqual(settings);
  expect(await similarityShown()).toBe('ready');
});

it('uninstalling removes everything the extension kept, and nothing else', async () => {
  await storeSomething();
  await indexOneTitle();
  const folder = store.extensionDirectory(await store.state(key));
  for (const kept of [
    'data/kv.json',
    'data/files/cache.bin',
    'similarity-index.json',
  ])
    expect(existsSync(join(folder, kept))).toBe(true);
  const outside = async () =>
    (await filesUnder(root)).filter(
      (file) => !join(root, file).startsWith(folder),
    );
  const before = await outside();

  await store.uninstall(key);

  expect(existsSync(folder)).toBe(false);
  expect(await outside()).toEqual(before);
  expect(await store.installed()).toEqual([]);
  await expect(
    store.act(key, { action: 'lookup' }, vi.fn()),
  ).rejects.toMatchObject({ status: 404 });
  expect(await extensionSimilarityProviders(store)).toEqual([]);
  // What Semantic and Balanced seed channels are told while they fall back.
  expect((await consult('similarity')).status.message).toBe(
    capabilityTable.similarity.whenMissing,
  );
});

it('a reinstalled extension starts fresh: no settings, no stored data, and its similarity is preparing', async () => {
  await storeSomething();
  await indexOneTitle();
  await store.uninstall(key);

  await store.install({
    source,
    repository,
    id: 'sample',
    commit: first.commit,
  });
  const fresh = await store.state(key);
  expect(fresh).toMatchObject({ enabled: false, configured: false });
  expect(await store.settings(fresh)).toEqual({});

  await store.configure(key, settings, true);
  expect(await similarityShown()).toBe('preparing');
  vi.mocked(runExtension).mockResolvedValueOnce({ value: { message: 'ok' } });
  await store.act(key, { action: 'lookup' }, vi.fn());
  const environment = vi.mocked(runExtension).mock.lastCall?.[4];
  expect(environment?.storage?.kv).toEqual({});
  expect(existsSync(join(environment!.storage!.dir, 'cache.bin'))).toBe(false);
});

it('uninstalling one extension leaves another installed extension and its saved value alone', async () => {
  await store.install({
    source,
    repository: otherRepository,
    id: 'other',
    commit: other.commit,
  });
  await store.configure(otherKey, { note: 'kept' }, true);

  await store.uninstall(key);

  expect((await store.installed()).map((state) => state.key)).toEqual([
    otherKey,
  ]);
  expect(await store.settings(await store.state(otherKey))).toEqual({
    note: 'kept',
  });
});
