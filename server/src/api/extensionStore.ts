import { serverOptions } from '@/globals.js';
import { defaultExtensionSource } from '../services/extensions/distribution.ts';
import {
  ExtensionError,
  type Settings,
} from '../services/extensions/schema.ts';
import { ExtensionStore } from '../services/extensions/store.ts';
import {
  StorePage,
  errorPage,
  type View,
} from '../services/extensions/views.ts';
import type { RouterPluginCallback } from '@/types/serverType.js';
import { getEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/v4';

const projectedProgram = z.object({
  type: z.string(),
  identifiers: z.array(z.unknown()).nullish(),
});
const identifier = z.object({ type: z.string(), id: z.string() });
type ReadProgram = (id: string) => Promise<unknown>;

async function submit(
  store: ExtensionStore,
  route: string,
  values: Settings,
  program: ReadProgram,
) {
  const key = values.key ?? '',
    view: View = {};
  let response: unknown;
  switch (route) {
    case 'source-add':
    case 'source-enable':
    case 'source-disable':
    case 'source-refresh':
      response = await store.changeSource(
        values.source ?? '',
        route === 'source-refresh' ? undefined : route !== 'source-disable',
      );
      view.mode = 'sources';
      break;
    case 'install': {
      const state = await store.install(values);
      response = state;
      if (!state.enabled) {
        view.mode = 'setup';
        view.key = state.key;
      }
      break;
    }
    case 'check-update': {
      const state = await store.checkUpdate(key);
      response = state;
      if (!state.update) view.message = 'Your installed version is current.';
      break;
    }
    case 'update':
      response = await store.update(key, values.commit ?? '');
      break;
    case 'enable':
    case 'disable':
      response = await store.toggle(key, route === 'enable');
      break;
    case 'test':
    case 'configure':
      response = await store.configure(key, values, route === 'configure');
      if (route === 'test') {
        view.mode = 'setup';
        view.key = key;
      }
      break;
    case 'action': {
      const action = await store.act(key, values, program);
      response = action;
      view.result = { key, action: values.action ?? '', data: action.result };
      break;
    }
    default:
      throw new ExtensionError(404, 'Unknown extension endpoint.');
  }
  return { response, view };
}

export const extensionStoreRouter: RouterPluginCallback = (
  app,
  _options,
  done,
) => {
  // Basic Auth is enforced by the server's parent onRequest hook.
  const manage =
    Boolean(
      getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_USER_ENV_VAR) &&
        getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_PASSWORD_ENV_VAR),
    ) || process.env.TUNARR_EXTENSION_TRUSTED_LAN === 'true';
  const csrf = randomBytes(32).toString('hex');
  const store = new ExtensionStore(
    join(serverOptions().databaseDirectory, 'extension-store'),
    process.env.TUNARR_EXTENSION_SOURCE ?? defaultExtensionSource,
  );
  const html = new StorePage(store, manage, csrf);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8192 },
    (_req, body, next) => next(null, body),
  );
  app.route({
    method: ['GET', 'POST'],
    url: '/extensions/*',
    bodyLimit: 8192,
    schema: { hide: true },
    handler: async (req, reply) => {
      reply.headers({
        'cache-control': 'no-store',
        'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
      });
      const path = new URL(req.url, 'http://localhost'),
        route = path.pathname.slice('/extensions/'.length);
      const json = req.headers.accept === 'application/json';
      try {
        if (!manage && (req.method !== 'GET' || route !== ''))
          throw new ExtensionError(
            403,
            'Extension management requires Tunarr Basic Auth or trusted LAN access.',
          );
        if (req.method === 'POST') {
          const { origin, host } = req.headers;
          if (
            !host ||
            (origin !== 'http://' + host && origin !== 'https://' + host)
          )
            throw new ExtensionError(
              403,
              'Open Settings → Extensions on this server to continue.',
            );
          if (
            typeof req.body !== 'string' ||
            !req.headers['content-type']?.startsWith(
              'application/x-www-form-urlencoded',
            )
          )
            throw new ExtensionError(415, 'Submit the extension form.');
          const params = new URLSearchParams(req.body);
          if (params.size > 100)
            throw new ExtensionError(413, 'Too many form fields.');
          const supplied = Buffer.from(params.get('_csrf') ?? '');
          if (
            supplied.length !== csrf.length ||
            !timingSafeEqual(supplied, Buffer.from(csrf))
          )
            throw new ExtensionError(
              403,
              'Reopen the extension manager and retry.',
            );
          const form: Settings = Object.assign(
            Object.create(null) as Settings,
            Object.fromEntries(params),
          );
          const program: ReadProgram = async (id) => {
            const result = await app.inject({
              method: 'GET',
              url: '/api/programs/' + id,
              headers: req.headers.authorization
                ? { authorization: req.headers.authorization }
                : {},
            });
            if (result.statusCode !== 200)
              throw new ExtensionError(
                result.statusCode,
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
          return await store.lock.runExclusive(async () => {
            await store.prepare();
            const { response, view } = await submit(
              store,
              route,
              form,
              program,
            );
            return json
              ? reply.send(response)
              : reply
                  .type('text/html; charset=utf-8')
                  .send(await html.render(view));
          });
        }
        if (route === 'health') return reply.send({ status: 'ok' });
        return await store.lock.runExclusive(async () => {
          await store.prepare();
          if (route === 'state')
            return reply.send({ installed: await store.installed() });
          if (route !== '' && route !== 'setup')
            throw new ExtensionError(404, 'Unknown extension endpoint.');
          const view: View =
            route === 'setup'
              ? { mode: 'setup', key: path.searchParams.get('key') ?? '' }
              : {};
          return reply
            .type('text/html; charset=utf-8')
            .send(await html.render(view));
        });
      } catch (error) {
        const expected = error instanceof ExtensionError;
        const message = expected
          ? error.message
          : 'Could not process the extension request.';
        reply.code(expected ? error.status : 500);
        return json
          ? reply.send({ error: message })
          : reply.type('text/html; charset=utf-8').send(errorPage(message));
      }
    },
  });
  done();
};
