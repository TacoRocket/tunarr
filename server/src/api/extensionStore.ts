import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import type { RouterPluginCallback } from '@/types/serverType.js';
import { BaseErrorSchema } from '@tunarr/types/api';
import { z } from 'zod/v4';
import {
  ExtensionError,
  extensionProgramSchema,
  type Installation,
  type Manifest,
  type Settings,
} from '../services/extensions/schema.ts';
import { providedCapabilities } from '../services/extensions/providedCapabilities.ts';
import { listingKey } from '../services/extensions/store.ts';
import { extensionStore } from '../services/extensions/storeInstance.ts';
import { getEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';
import { currentExtensionApi } from '../services/extensions/version.ts';

const FieldSchema = z.object({
  key: z.string(),
  type: z.enum(['url', 'secret', 'text', 'tunarrProgram']),
  label: z.string(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});
const ReleaseSchema = z.object({ version: z.string(), commit: z.string() });
const AccessGuideSchema = z.object({
  reads: z.string(),
  changes: z.string(),
  connectsTo: z.string(),
  downloads: z.string(),
});
// What the manifest lets the extension do, shown next to the publisher's
// access guide: requests by method and address setting, sizes, services.
const AllowanceSchema = z.object({
  memoryMiB: z.number().optional(),
  storageMiB: z.number().optional(),
  downloadBytes: z.number().optional(),
  requests: z.array(z.object({ method: z.string(), setting: z.string() })),
  provides: z.array(z.string()),
});
const ListingSchema = ReleaseSchema.extend({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  repository: z.string(),
  path: z.string().optional(),
  hidden: z.boolean(),
  preview: AllowanceSchema.extend({
    maintainer: z.string().optional(),
    issueTracker: z.string().optional(),
    accessGuide: AccessGuideSchema.optional(),
    problem: z.string().optional(),
  }).optional(),
});
const ExtensionSourceSchema = z.object({
  url: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  error: z.string().optional(),
  entries: z.array(ListingSchema),
});
const InstalledExtensionSchema = ReleaseSchema.extend({
  key: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  repository: z.string(),
  source: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  update: ReleaseSchema.nullable(),
  connectionTest: z.boolean(),
  // False when the extension was built for an extension API this Tunarr
  // doesn't run; problem then says what to do.
  compatible: z.boolean(),
  problem: z.string().optional(),
  maintainer: z.string().optional(),
  issueTracker: z.string().optional(),
  accessGuide: AccessGuideSchema.optional(),
  allowance: AllowanceSchema.optional(),
  setupHelp: z.string().optional(),
  credentialHelp: z.string().optional(),
  settings: z.array(FieldSchema),
  // Saved address and text values. Secrets are never returned; savedSecrets
  // lists the secret fields that have a stored value.
  values: z.record(z.string(), z.string()),
  savedSecrets: z.array(z.string()),
  actions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      inputs: z.array(FieldSchema),
      resultLabels: z.record(z.string(), z.string()).optional(),
      // Shown as a button on the card; every action is listed in details.
      quick: z.boolean(),
    }),
  ),
  // Each capability it provides and how far along it is (`off` while the
  // extension is turned off or not set up).
  capabilities: z.array(
    z.object({
      capability: z.string(),
      label: z.string(),
      state: z.enum(['ready', 'preparing', 'off']),
      message: z.string(),
    }),
  ),
});

const ExtensionStoreStateSchema = z.object({
  // The extension API this Tunarr runs. Below 1.0 the API is an early beta.
  apiVersion: z.string(),
  canManage: z.boolean(),
  installed: z.array(InstalledExtensionSchema),
  sources: z.array(ExtensionSourceSchema),
});
type ExtensionStoreState = z.infer<typeof ExtensionStoreStateSchema>;

const KeyBodySchema = z.object({ key: z.string() });
const SettingsBodySchema = KeyBodySchema.extend({
  values: z.record(z.string(), z.string()),
  clearSecrets: z.array(z.string()).default([]),
  // Saved together with the settings, so one request decides the state.
  enabled: z.boolean().default(true),
});
const SourceBodySchema = z.object({ url: z.string() });
// Changes answer with this; the page then reloads the store state.
const DoneSchema = z.object({ status: z.literal('ok') });
const ok = { status: 'ok' as const };

function formSettings(body: z.infer<typeof SettingsBodySchema>): Settings {
  const form = Object.assign(Object.create(null) as Settings, body.values);
  for (const key of body.clearSecrets) form['clear:' + key] = 'on';
  return form;
}

export const extensionStoreRouter: RouterPluginCallback = (
  fastify,
  _options,
  done,
) => {
  // Basic Auth, when configured, is enforced by the server's onRequest hook.
  const canManage =
    Boolean(
      getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_USER_ENV_VAR) &&
        getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_PASSWORD_ENV_VAR),
    ) || process.env.TUNARR_EXTENSION_TRUSTED_LAN === 'true';
  const logger = LoggerFactory.child({
    caller: import.meta,
    className: 'ExtensionStore',
  });
  const store = extensionStore();

  async function describe(
    state: Installation,
    listedNames: Map<string, string>,
  ) {
    let manifest: Manifest;
    try {
      manifest = await store.manifest(state);
    } catch (error) {
      // Built for another extension API: show it, offer update and uninstall.
      return {
        key: state.key,
        id: state.id,
        // The old manifest can't be read, so use the name its source lists.
        name: listedNames.get(state.key) ?? state.id,
        description: '',
        repository: state.repository,
        source: state.source,
        version: state.version,
        commit: state.commit,
        enabled: false,
        configured: false,
        update: state.update ?? null,
        connectionTest: false,
        compatible: false,
        problem:
          error instanceof ExtensionError
            ? error.message
            : "Tunarr can't read this extension.",
        settings: [],
        values: {},
        savedSecrets: [],
        actions: [],
        capabilities: [],
      };
    }
    const saved = await store.settings(state);
    const values: Record<string, string> = {};
    const savedSecrets: string[] = [];
    for (const field of manifest.settings) {
      const value = saved[field.key];
      if (field.type === 'secret') {
        if (value) savedSecrets.push(field.key);
      } else if (value !== undefined) values[field.key] = value;
    }
    return {
      key: state.key,
      id: state.id,
      name: manifest.name,
      description: manifest.description,
      repository: state.repository,
      source: state.source,
      version: state.version,
      commit: state.commit,
      enabled: state.enabled,
      configured: state.configured,
      update: state.update ?? null,
      connectionTest: manifest.connectionTest,
      compatible: true,
      maintainer: manifest.maintainer,
      issueTracker: manifest.issueTracker,
      accessGuide: manifest.accessGuide,
      allowance: {
        memoryMiB: manifest.memoryMiB,
        storageMiB: manifest.storageMiB,
        downloadBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
        requests: manifest.requests.map((r) => ({
          method: r.method,
          setting:
            manifest.settings.find((f) => f.key === r.baseUrlSetting)?.label ??
            r.baseUrlSetting,
        })),
        provides: manifest.provides,
      },
      setupHelp: manifest.setupHelp,
      credentialHelp: manifest.credentialHelp,
      settings: manifest.settings,
      values,
      savedSecrets,
      actions: manifest.actions,
      capabilities: await providedCapabilities(store, state, manifest),
    };
  }

  const apiVersion = currentExtensionApi;

  // Name every enabled extension at startup, so a problem report shows what
  // was running and who maintains it.
  void store.lock
    .runExclusive(async () => {
      await store.prepare();
      for (const state of await store.installed()) {
        if (!state.enabled) continue;
        const manifest = await store.manifest(state).catch(() => undefined);
        if (!manifest) continue;
        logger.info(
          'Extension %s %s is enabled. It is maintained by %s, not Tunarr; report problems at %s',
          manifest.name,
          state.version,
          manifest.maintainer,
          manifest.issueTracker,
        );
      }
    })
    .catch((error: unknown) =>
      logger.warn(error, 'Could not list installed extensions'),
    );

  async function snapshot(): Promise<ExtensionStoreState> {
    const hidden = new Set(await store.hiddenListings());
    const sources = (await store.sources()).map(({ previews, ...source }) => ({
      ...source,
      name: source.url.slice('https://github.com/'.length),
      entries: source.entries.map((entry) => ({
        ...entry,
        key: listingKey(entry),
        hidden: hidden.has(listingKey(entry)),
        preview: previews[listingKey(entry)],
      })),
    }));
    if (!canManage) return { apiVersion, canManage, installed: [], sources };
    const listedNames = new Map(
      sources.flatMap((source) =>
        source.entries.map(
          (entry) =>
            [
              `${entry.repository.toLowerCase()}:${entry.id}`,
              entry.name,
            ] as const,
        ),
      ),
    );
    const installed = await Promise.all(
      (await store.installed()).map((state) => describe(state, listedNames)),
    );
    installed.sort((a, b) => a.name.localeCompare(b.name));
    return { apiVersion, canManage, installed, sources };
  }

  // Every store operation runs one at a time: actions share a single worker
  // slot, and the files under extension-store are rewritten in place.
  function locked<T>(manage: boolean, run: () => Promise<T>) {
    if (manage && !canManage)
      throw new ExtensionError(
        403,
        'Managing extensions requires Tunarr Basic Auth or TUNARR_EXTENSION_TRUSTED_LAN=true.',
      );
    return store.lock.runExclusive(async () => {
      await store.prepare();
      return run();
    });
  }

  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof ExtensionError)
      return reply.status(error.status).send({ message: error.message });
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    return reply.status(status).send({
      message:
        status < 500 && error instanceof Error
          ? error.message
          : 'Could not process the extension request.',
    });
  });

  const tags = ['Extensions'];

  fastify.get(
    '/',
    {
      schema: {
        tags,
        response: { 200: ExtensionStoreStateSchema, 500: BaseErrorSchema },
      },
    },
    async (_req, res) => res.send(await locked(false, snapshot)),
  );

  fastify.post(
    '/sources',
    {
      schema: {
        tags,
        body: SourceBodySchema,
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.changeSource(req.body.url, true);
          return ok;
        }),
      ),
  );

  fastify.put(
    '/sources',
    {
      schema: {
        tags,
        body: SourceBodySchema.extend({ enabled: z.boolean() }),
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.changeSource(req.body.url, req.body.enabled);
          return ok;
        }),
      ),
  );

  fastify.post(
    '/sources/refresh',
    {
      schema: {
        tags,
        body: SourceBodySchema,
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.changeSource(req.body.url);
          return ok;
        }),
      ),
  );

  fastify.post(
    '/install',
    {
      schema: {
        tags,
        body: z.object({
          source: z.string(),
          id: z.string(),
          repository: z.string(),
          commit: z.string(),
        }),
        response: { 200: z.object({ key: z.string() }) },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          const installed = await store.install(
            Object.assign(Object.create(null) as Settings, req.body),
          );
          return { key: installed.key };
        }),
      ),
  );

  fastify.post(
    '/uninstall',
    {
      schema: {
        tags,
        body: KeyBodySchema,
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.uninstall(req.body.key);
          return ok;
        }),
      ),
  );

  fastify.put(
    '/listings/hidden',
    {
      schema: {
        tags,
        body: z.object({ key: z.string(), hidden: z.boolean() }),
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.setHidden(req.body.key, req.body.hidden);
          return ok;
        }),
      ),
  );

  fastify.put(
    '/enabled',
    {
      schema: {
        tags,
        body: KeyBodySchema.extend({ enabled: z.boolean() }),
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.toggle(req.body.key, req.body.enabled);
          return ok;
        }),
      ),
  );

  fastify.post(
    '/settings/test',
    {
      schema: {
        tags,
        body: SettingsBodySchema,
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, () =>
          store.configure(req.body.key, formSettings(req.body), false),
        ),
      ),
  );

  fastify.put(
    '/settings',
    {
      schema: {
        tags,
        body: SettingsBodySchema,
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.configure(
            req.body.key,
            formSettings(req.body),
            true,
            req.body.enabled,
          );
          return ok;
        }),
      ),
  );

  fastify.post(
    '/updates/check',
    {
      schema: {
        tags,
        body: KeyBodySchema,
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.checkUpdate(req.body.key);
          return ok;
        }),
      ),
  );

  fastify.post(
    '/updates/apply',
    {
      schema: {
        tags,
        body: KeyBodySchema.extend({ commit: z.string() }),
        response: { 200: DoneSchema },
      },
    },
    async (req, res) =>
      res.send(
        await locked(true, async () => {
          await store.update(req.body.key, req.body.commit);
          return ok;
        }),
      ),
  );

  fastify.post(
    '/actions/run',
    {
      schema: {
        tags,
        body: KeyBodySchema.extend({
          action: z.string(),
          inputs: z.record(z.string(), z.string()).default({}),
        }),
        response: {
          200: z.object({
            version: z.string(),
            result: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    async (req, res) => {
      const authorization = req.headers.authorization;
      const program = async (id: string) => {
        const result = await fastify.inject({
          method: 'GET',
          url: '/api/programs/' + id,
          headers: authorization ? { authorization } : {},
        });
        if (result.statusCode !== 200)
          throw new ExtensionError(
            result.statusCode === 404 ? 404 : 502,
            'Could not read the selected Tunarr program.',
          );
        return extensionProgramSchema.parse(result.json());
      };
      const form = Object.assign(
        Object.create(null) as Settings,
        req.body.inputs,
        { action: req.body.action },
      );
      return res.send(
        await locked(true, () => store.act(req.body.key, form, program)),
      );
    },
  );

  done();
};
