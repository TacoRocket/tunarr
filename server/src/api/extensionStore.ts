import { serverOptions } from '@/globals.js';
import type { RouterPluginCallback } from '@/types/serverType.js';
import { BaseErrorSchema } from '@tunarr/types/api';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { defaultExtensionSource } from '../services/extensions/distribution.ts';
import {
  ExtensionError,
  type Installation,
  type Settings,
} from '../services/extensions/schema.ts';
import { ExtensionStore } from '../services/extensions/store.ts';
import { getEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';

const projectedProgram = z.object({
  type: z.string(),
  identifiers: z.array(z.unknown()).nullish(),
});
const identifier = z.object({ type: z.string(), id: z.string() });

const FieldSchema = z.object({
  key: z.string(),
  type: z.enum(['url', 'secret', 'text', 'tunarrProgram']),
  label: z.string(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});
const ReleaseSchema = z.object({ version: z.string(), commit: z.string() });
const ListingSchema = ReleaseSchema.extend({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  repository: z.string(),
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
    }),
  ),
});
const ExtensionStoreStateSchema = z.object({
  canManage: z.boolean(),
  installed: z.array(InstalledExtensionSchema),
  sources: z.array(ExtensionSourceSchema),
});
type ExtensionStoreState = z.infer<typeof ExtensionStoreStateSchema>;

const KeyBodySchema = z.object({ key: z.string() });
const SettingsBodySchema = KeyBodySchema.extend({
  values: z.record(z.string(), z.string()),
  clearSecrets: z.array(z.string()).default([]),
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
  const store = new ExtensionStore(
    join(serverOptions().databaseDirectory, 'extension-store'),
    process.env.TUNARR_EXTENSION_SOURCE ?? defaultExtensionSource,
  );

  async function describe(state: Installation) {
    const manifest = await store.manifest(state);
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
      setupHelp: manifest.setupHelp,
      credentialHelp: manifest.credentialHelp,
      settings: manifest.settings,
      values,
      savedSecrets,
      actions: manifest.actions,
    };
  }

  async function snapshot(): Promise<ExtensionStoreState> {
    const sources = (await store.sources()).map((source) => ({
      ...source,
      name: source.url.slice('https://github.com/'.length),
    }));
    if (!canManage) return { canManage, installed: [], sources };
    const installed = await Promise.all(
      (await store.installed()).map((state) => describe(state)),
    );
    installed.sort((a, b) => a.name.localeCompare(b.name));
    return { canManage, installed, sources };
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
          await store.configure(req.body.key, formSettings(req.body), true);
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
        const p = projectedProgram.parse(result.json());
        return {
          type: p.type,
          identifiers: (p.identifiers ?? []).flatMap((value) => {
            const item = identifier.safeParse(value);
            return item.success ? [item.data] : [];
          }),
        };
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
