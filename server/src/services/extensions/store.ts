import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Mutex } from 'async-mutex';
import { z } from 'zod/v4';
import { serviceRequest } from './broker.ts';
import type { RunEnvironment, StorageWrites } from './runtime.ts';
import { carriedSettings } from './carryOver.ts';
import { runExtension } from './runtime.ts';
import {
  ExtensionError,
  actionResultSchema,
  checkApiVersion,
  checked,
  feedSchema,
  manifestSchema,
  savedSources,
  settingsSchema,
  sourceDocument,
  sourceUrl,
  stateSchema,
  packageFile,
  type Installation,
  type Listing,
  type ListingPreview,
  type Manifest,
  type Release,
  type Settings,
  type Source,
} from './schema.ts';
import { listingSuffix } from './version.ts';

const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

async function readSaved<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return checked(
    schema,
    JSON.parse(contents),
    'Invalid saved extension state.',
  );
}

async function writePrivate(path: string, bytes: string | Buffer) {
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function download(
  repository: string,
  revision: string,
  filename: string,
  limit: number,
  timeoutMs = 8000,
) {
  const url =
    'https://raw.githubusercontent.com/' +
    [repository, revision, filename].join('/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
      headers: { 'User-Agent': 'Tunarr-extension-host' },
    });
    if (!response.ok || !response.body)
      throw new ExtensionError(
        502,
        'GitHub returned HTTP ' + response.status + '.',
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const piece = await reader.read();
      if (piece.done) break;
      const value: unknown = piece.value;
      if (!(value instanceof Uint8Array))
        throw new ExtensionError(502, 'Invalid download from GitHub.');
      length += value.length;
      if (length > limit)
        throw new ExtensionError(
          502,
          'GitHub returned more data than the host supports.',
        );
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(502, 'Could not reach GitHub.');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function githubJson(
  repository: string,
  revision: string,
  name: string,
  limit: number,
): Promise<unknown> {
  const bytes = await download(repository, revision, name, limit);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ExtensionError(502, 'Invalid JSON returned by GitHub.');
  }
}

export const listingKey = (entry: Pick<Listing, 'repository' | 'id'>) =>
  entry.repository.toLowerCase() + ':' + entry.id;

// Read a listing's manifest at its commit for what Settings shows before
// install. A manifest this Tunarr can't use still gets a preview, with the
// reason in `problem`.
async function preview(entry: Listing): Promise<ListingPreview> {
  try {
    const manifest = await getManifest(
      entry.repository,
      entry.path,
      entry.id,
      entry,
    );
    const labels = new Map(manifest.settings.map((f) => [f.key, f.label]));
    return {
      maintainer: manifest.maintainer,
      issueTracker: manifest.issueTracker,
      accessGuide: manifest.accessGuide,
      memoryMiB: manifest.memoryMiB,
      storageMiB: manifest.storageMiB,
      downloadBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      requests: manifest.requests.map((r) => ({
        method: r.method,
        setting: labels.get(r.baseUrlSetting) ?? r.baseUrlSetting,
      })),
      provides: manifest.provides,
    };
  } catch (error) {
    return {
      requests: [],
      provides: [],
      problem:
        error instanceof ExtensionError
          ? error.message
          : "Tunarr couldn't read this extension's manifest.",
    };
  }
}

async function refresh(source: Source) {
  try {
    const document = await githubJson(
      source.url.slice('https://github.com/'.length),
      'HEAD',
      `source-${listingSuffix}.json`,
      128 * 1024,
    );
    source.entries = checked(
      sourceDocument,
      document,
      'Unsupported or invalid extension source.',
    ).extensions;
    delete source.error;
    // One small manifest read per listing; listings pin a commit, so the
    // result stays valid until the source changes.
    const previews: Record<string, ListingPreview> = {};
    for (const entry of source.entries)
      previews[listingKey(entry)] = await preview(entry);
    source.previews = previews;
  } catch (error) {
    if (!(error instanceof ExtensionError)) throw error;
    source.entries = [];
    source.previews = {};
    source.error = error.message;
  }
  return source;
}

async function getManifest(
  repository: string,
  path: string | undefined,
  id: string,
  release: Release,
) {
  const raw = await githubJson(
    repository,
    release.commit,
    packageFile(path, 'tunarr-extension.json'),
    16384,
  );
  checkApiVersion(raw);
  const manifest = checked(
    manifestSchema,
    raw,
    "This extension's manifest is invalid.",
  );
  if (manifest.id !== id || manifest.version !== release.version)
    throw new ExtensionError(
      422,
      'The extension manifest does not match its listing.',
    );
  return manifest;
}

function newer(a: string, b: string) {
  const previous = b.split('.').map(Number);
  for (const [i, part] of a.split('.').entries()) {
    const delta = Number(part) - previous[i]!;
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export class ExtensionStore {
  readonly lock = new Mutex();
  private readonly installations: string;
  private ready = false;
  constructor(
    private readonly root: string,
    private readonly defaultSource: string,
    // Tunarr's own listening ports, which extensions may not reach locally.
    private readonly tunarrPorts: () => number[],
  ) {
    this.installations = join(root, 'installations');
  }

  async prepare() {
    if (this.ready) return;
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const stat = await lstat(this.root);
    if (
      !stat.isDirectory() ||
      (process.geteuid && stat.uid !== process.geteuid())
    ) {
      throw new ExtensionError(
        503,
        'The extension store needs a private directory owned by Tunarr.',
      );
    }
    if (process.platform !== 'win32') await chmod(this.root, 0o700);
    await mkdir(this.installations, { mode: 0o700, recursive: true });
    this.ready = true;
  }

  async hiddenListings(): Promise<string[]> {
    const saved = await readSaved(
      join(this.root, 'sources.json'),
      savedSources,
    );
    return saved?.hidden ?? [];
  }

  async setHidden(key: string, hidden: boolean) {
    const sources = await this.sources();
    const current = new Set(await this.hiddenListings());
    if (hidden) current.add(key);
    else current.delete(key);
    await this.saveSources(sources, [...current]);
  }

  async sources(): Promise<Source[]> {
    const path = join(this.root, 'sources.json');
    const saved = await readSaved(path, savedSources);
    if (saved?.listing === listingSuffix) return saved.sources;
    let sources: Source[];
    if (saved) {
      // Saved for another API major: those listings offer packages this
      // Tunarr can't run, so read each enabled source's current listing.
      sources = await Promise.all(
        saved.sources.map((source) =>
          source.enabled ? refresh(source) : Promise.resolve(source),
        ),
      );
    } else {
      if (!this.defaultSource.trim()) return [];
      sources = [
        await refresh({
          url: sourceUrl(this.defaultSource),
          enabled: true,
          entries: [],
          previews: {},
        }),
      ];
    }
    await this.saveSources(sources, saved?.hidden ?? []);
    return sources;
  }

  private async saveSources(sources: Source[], hidden?: string[]) {
    await writePrivate(
      join(this.root, 'sources.json'),
      JSON.stringify({
        listing: listingSuffix,
        sources,
        hidden: hidden ?? (await this.hiddenListings()),
      }),
    );
  }

  async changeSource(url: string, enabled?: boolean) {
    const canonical = sourceUrl(url);
    const sources = await this.sources();
    let source = sources.find(
      (s) => s.url.toLowerCase() === canonical.toLowerCase(),
    );
    if (!source) {
      if (enabled !== true)
        throw new ExtensionError(404, 'Unknown extension source.');
      source = { url: canonical, enabled: false, entries: [], previews: {} };
      sources.push(source);
    }
    if (enabled === undefined && !source.enabled)
      throw new ExtensionError(409, 'Enable this source before refreshing it.');
    if (enabled === undefined || (enabled && !source.enabled))
      await refresh(source);
    if (enabled !== undefined) source.enabled = enabled;
    if (!source.enabled) {
      source.entries = [];
      source.previews = {};
      delete source.error;
    }
    await this.saveSources(sources);
    return source;
  }

  private directory(key: string) {
    return join(this.installations, sha256(key));
  }
  async installed() {
    const dirs = await readdir(this.installations, { withFileTypes: true });
    const states = await Promise.all(
      dirs
        .filter((d) => d.isDirectory())
        .map((d) =>
          readSaved(
            join(this.installations, d.name, 'state.json'),
            stateSchema,
          ),
        ),
    );
    return states.filter((s): s is Installation => s !== undefined);
  }
  async state(key: string) {
    const state = await readSaved(
      join(this.directory(key), 'state.json'),
      stateSchema,
    );
    if (!state) throw new ExtensionError(404, 'Extension is not installed.');
    if (state.key !== key)
      throw new ExtensionError(
        409,
        'Installed extension identity does not match.',
      );
    return state;
  }
  private async save(state: Installation) {
    await writePrivate(
      join(this.directory(state.key), 'state.json'),
      JSON.stringify(state),
    );
    return state;
  }
  // An installed extension built for an API this Tunarr no longer runs
  // throws here with a message saying so; the caller decides what to show.
  async manifest(state: Installation) {
    const raw = await readSaved(
      join(this.directory(state.key), state.commit + '.json'),
      z.unknown(),
    );
    if (raw === undefined)
      throw new ExtensionError(500, 'The installed manifest is missing.');
    checkApiVersion(raw);
    return checked(
      manifestSchema,
      raw,
      "This extension's manifest is invalid.",
    );
  }
  async settings(state: Installation) {
    const saved = await readSaved(
      join(this.directory(state.key), state.settingsFile ?? 'settings.json'),
      settingsSchema,
    );
    return Object.assign(Object.create(null) as Settings, saved);
  }
  async install(form: Settings) {
    const canonical = sourceUrl(form.source ?? '');
    const source = (await this.sources()).find(
      (s) => s.url.toLowerCase() === canonical.toLowerCase(),
    );
    if (!source?.enabled)
      throw new ExtensionError(
        409,
        'Enable this source before installing its extension.',
      );
    const entry = source.entries.find((e) => e.id === form.id);
    if (
      !entry ||
      entry.commit !== form.commit ||
      entry.repository !== form.repository
    ) {
      throw new ExtensionError(
        409,
        'The displayed listing changed. Review the publisher and version before installing.',
      );
    }
    const { repository, id, version, commit, path } = entry,
      key = listingKey(entry);
    if ((await this.installed()).some((s) => s.key === key))
      throw new ExtensionError(
        409,
        "This publisher's extension is already installed.",
      );
    await mkdir(this.directory(key), { recursive: true, mode: 0o700 });
    return this.installRelease({
      key,
      id,
      repository,
      path,
      version,
      commit,
      source: source.url,
      installed: true,
      enabled: false,
      configured: false,
    });
  }

  async checkUpdate(key: string) {
    const state = await this.state(key);
    const feed = checked(
      feedSchema,
      await githubJson(
        state.repository,
        'HEAD',
        packageFile(state.path, `feed-${listingSuffix}.json`),
        4096,
      ),
      'Invalid extension release feed.',
    );
    if (feed.id !== state.id)
      throw new ExtensionError(
        422,
        'The release feed does not belong to this extension.',
      );
    state.update = null;
    if (newer(feed.latest.version, state.version)) {
      await getManifest(state.repository, state.path, state.id, feed.latest);
      state.update = feed.latest;
    }
    return this.save(state);
  }

  async update(key: string, commit: string) {
    const old = await this.state(key);
    if (!old.update || old.update.commit !== commit)
      throw new ExtensionError(
        409,
        'Check for an update and review the available version first.',
      );
    return this.installRelease({ ...old, ...old.update, update: null }, old);
  }

  private async installRelease(state: Installation, previous?: Installation) {
    const manifest = await getManifest(
      state.repository,
      state.path,
      state.id,
      state,
    );
    const code = await download(
      state.repository,
      state.commit,
      packageFile(state.path, manifest.entrypoint),
      128 * 1024,
    );
    if (sha256(code) !== manifest.sha256)
      throw new ExtensionError(422, 'Extension package checksum mismatch.');
    const directory = this.directory(state.key);
    // Data files ship next to adapter.js at the same commit. Each is checked
    // against its declared size and hash before the release is kept.
    const filesDir = join(directory, 'files-' + state.commit);
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      const bytes = await download(
        state.repository,
        state.commit,
        packageFile(state.path, file.name),
        file.bytes,
        Math.max(8000, (file.bytes / (256 * 1024)) * 1000),
      );
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new ExtensionError(
          422,
          `The extension file ${file.name} doesn't match its manifest.`,
        );
      await writePrivate(join(filesDir, file.name), bytes);
    }
    if (!previous) {
      state.configured = state.enabled =
        manifest.settings.length === 0 && !manifest.connectionTest;
    } else {
      // A previous version built for another API can't be run, but its
      // manifest can still be read for what carries over.
      const old = await this.manifest(previous).catch(() => undefined);
      if (
        !old ||
        !isDeepStrictEqual(old.settings, manifest.settings) ||
        old.connectionTest !== manifest.connectionTest ||
        !isDeepStrictEqual(old.requests, manifest.requests)
      ) {
        state.configured = state.enabled = false;
        // Read the previous manifest as plain data, so its field types and
        // secret destinations count even when this Tunarr can't run it.
        const previousManifest = await readSaved(
          join(directory, previous.commit + '.json'),
          z.unknown(),
        ).catch(() => undefined);
        const retained = carriedSettings(
          previousManifest,
          manifest,
          await this.settings(previous),
        );
        state.settingsFile = 'settings-' + state.commit + '.json';
        await writePrivate(
          join(directory, state.settingsFile),
          JSON.stringify(retained),
        );
      }
    }
    await writePrivate(join(directory, state.commit + '.js'), code);
    await writePrivate(
      join(directory, state.commit + '.json'),
      JSON.stringify(manifest),
    );
    const saved = await this.save(state);
    // Remove data files from the previous release.
    for (const entry of await readdir(directory))
      if (entry.startsWith('files-') && entry !== 'files-' + state.commit)
        await rm(join(directory, entry), { recursive: true, force: true });
    return saved;
  }

  // Removes the package, its manifest, its settings and saved credentials.
  // Nothing outside the extension's own folder is touched.
  async uninstall(key: string) {
    await this.state(key);
    await rm(this.directory(key), { recursive: true, force: true });
  }

  async toggle(key: string, enabled: boolean) {
    const state = await this.state(key);
    if (enabled && !state.configured)
      throw new ExtensionError(409, 'Configure the extension first.');
    return this.save({ ...state, enabled });
  }

  async configure(
    key: string,
    form: Settings,
    persist: boolean,
    enabled = true,
  ) {
    const state = await this.state(key),
      manifest = await this.manifest(state),
      saved = await this.settings(state);
    const settings: Settings = Object.create(null) as Settings;
    let sameAddresses = true;
    for (const field of manifest.settings) {
      let value = (form[field.key] ?? '').trim();
      if (field.type === 'url') {
        value = value.replace(/\/+$/, '');
        if (value) {
          const url = URL.parse(value);
          if (
            !url ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          ) {
            throw new ExtensionError(
              400,
              'Enter a valid HTTP or HTTPS URL for ' + field.label + '.',
            );
          }
        }
        if (value !== saved[field.key]) sameAddresses = false;
      }
      settings[field.key] = value;
    }
    for (const field of manifest.settings) {
      if (
        field.type === 'secret' &&
        !settings[field.key] &&
        sameAddresses &&
        form['clear:' + field.key] !== 'on'
      )
        settings[field.key] = saved[field.key] ?? '';
      if (field.required && !settings[field.key])
        throw new ExtensionError(400, 'Enter ' + field.label + '.');
    }
    // A connection test passes when the package's `test` action answers
    // without an error.
    let result: Record<string, unknown> = { message: 'Saved.' };
    if (manifest.connectionTest) {
      result = await this.run(state, manifest, settings, { action: 'test' });
    } else if (!persist)
      throw new ExtensionError(
        409,
        'This extension does not declare a connection test.',
      );
    if (persist) {
      await writePrivate(
        join(this.directory(key), state.settingsFile ?? 'settings.json'),
        JSON.stringify(settings),
      );
      await this.save({ ...state, enabled, configured: true });
    }
    return result;
  }

  async act(
    key: string,
    form: Settings,
    program: (id: string) => Promise<unknown>,
  ) {
    const state = await this.state(key);
    if (!state.enabled)
      throw new ExtensionError(409, 'This extension is disabled.');
    const manifest = await this.manifest(state),
      action = manifest.actions.find((a) => a.id === form.action);
    if (!action) throw new ExtensionError(404, 'Unknown extension action.');
    const payload: Record<string, unknown> = { action: action.id };
    for (const field of action.inputs) {
      const value = form[field.key]?.trim();
      if (!value) {
        if (field.required)
          throw new ExtensionError(400, 'Enter ' + field.label + '.');
        continue;
      }
      if (field.type === 'tunarrProgram') {
        if (!z.uuid().safeParse(value).success)
          throw new ExtensionError(400, 'Enter a valid Tunarr program ID.');
        payload[field.key] = await program(value);
      } else payload[field.key] = value;
    }
    return {
      version: state.version,
      result: await this.run(
        state,
        manifest,
        await this.settings(state),
        payload,
      ),
    };
  }

  private async environment(
    state: Installation,
    manifest: Manifest,
  ): Promise<RunEnvironment> {
    const directory = this.directory(state.key);
    const filesDir = join(directory, 'files-' + state.commit);
    const environment: RunEnvironment = {
      computeModule: manifest.computeModule,
      memoryBytes: manifest.memoryMiB * 1024 * 1024,
      files: Object.fromEntries(
        manifest.files.map((f) => [f.name, join(filesDir, f.name)]),
      ),
    };
    if (manifest.storageMiB > 0) {
      const kv = await readSaved(
        join(directory, 'data', 'kv.json'),
        settingsSchema,
      );
      environment.storage = {
        kv: kv ?? {},
        dir: join(directory, 'data', 'files'),
        maxBytes: manifest.storageMiB * 1024 * 1024,
      };
    }
    return environment;
  }

  // Storage changes count only for a run that succeeded.
  private async commit(state: Installation, writes: StorageWrites) {
    const data = join(this.directory(state.key), 'data');
    await mkdir(join(data, 'files'), { recursive: true, mode: 0o700 });
    if (writes.kv)
      await writePrivate(join(data, 'kv.json'), JSON.stringify(writes.kv));
    for (const [name, bytes] of writes.files) {
      const path = join(data, 'files', name);
      if (bytes) await writePrivate(path, Buffer.from(bytes));
      else await rm(path, { force: true });
    }
  }

  private async run<T extends Record<string, unknown>>(
    state: Installation,
    manifest: Manifest,
    settings: Settings,
    payload: Record<string, unknown>,
    answer: z.ZodType<T> = actionResultSchema as unknown as z.ZodType<T>,
  ): Promise<T> {
    const code = await readFile(
      join(this.directory(state.key), state.commit + '.js'),
      'utf8',
    );
    const text = Object.fromEntries(
      manifest.settings
        .filter((f) => f.type === 'text' && Object.hasOwn(settings, f.key))
        .map((f) => [f.key, settings[f.key]]),
    );
    const { value, writes } = await runExtension(
      { id: state.id, name: manifest.name },
      code,
      { ...text, ...payload },
      (id, request, remainingMs) =>
        serviceRequest(
          manifest,
          settings,
          id,
          request,
          remainingMs,
          this.tunarrPorts(),
        ),
      await this.environment(state, manifest),
    );
    const result = checked(
      answer,
      value,
      `${manifest.name} finished without saying what it found. Report it to its publisher.`,
    );
    if (writes) await this.commit(state, writes);
    return result;
  }

  /** The enabled, set-up extension that provides `kind`, if any. */
  async provider(kind: Manifest['provides'][number]) {
    for (const state of await this.installed()) {
      if (!state.enabled || !state.configured) continue;
      const manifest = await this.manifest(state).catch(() => undefined);
      if (manifest?.provides.includes(kind)) return { state, manifest };
    }
    return undefined;
  }

  /** Runs a provider call that Tunarr makes on its own, not a button. */
  async provide<T extends Record<string, unknown>>(
    state: Installation,
    manifest: Manifest,
    payload: Record<string, unknown>,
    answer: z.ZodType<T>,
  ) {
    return this.run(
      state,
      manifest,
      await this.settings(state),
      payload,
      answer,
    );
  }

  /** Folder for host-owned bookkeeping about this extension. */
  extensionDirectory(state: Installation) {
    return this.directory(state.key);
  }
}
