import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runExtension } from './runtime.ts';
import { ExtensionStore } from './store.ts';

vi.mock('./runtime.ts', () => ({ runExtension: vi.fn() }));

const repository = 'example/packages';
const source = 'https://github.com/' + repository;
const key = repository + ':sample';
const first = { version: '1.0.0', commit: '1'.repeat(40) };
const next = { version: '1.0.1', commit: '2'.repeat(40) };
const settings = { address: 'https://media.example', apiKey: 'fixture-key' };
const files = new Map<string, string>();
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
  files.set(
    'HEAD/source-v0.json',
    JSON.stringify({ schemaVersion: 1, extensions: [listing] }),
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
      }),
    );
  }
  vi.stubGlobal('fetch', async (url: string) => {
    const prefix = 'https://raw.githubusercontent.com/' + repository + '/';
    const body = url.startsWith(prefix)
      ? files.get(url.slice(prefix.length))
      : undefined;
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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  files.clear();
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
