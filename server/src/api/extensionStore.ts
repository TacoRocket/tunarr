import { serverOptions } from '@/globals.js';
import type { RouterPluginCallback } from '@/types/serverType.js';
import { getEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const extensionStoreRouter: RouterPluginCallback = (
  app,
  _options,
  done,
) => {
  const user = getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_USER_ENV_VAR);
  const password = getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_PASSWORD_ENV_VAR);
  // Basic Auth, when configured, is enforced by Server's parent onRequest hook.
  const manage =
    Boolean(user && password) ||
    process.env.TUNARR_EXTENSION_TRUSTED_LAN === 'true';
  const entry = process.env.TUNARR_EXTENSION_HOST;
  let starting: Promise<string> | undefined;
  let child: ChildProcess | undefined;
  let closing = false;

  async function start() {
    if (!entry) throw new Error('Extension runtime unavailable');
    const directory = await mkdtemp(join(tmpdir(), 'tunarr-store-'));
    const socket = join(directory, 'store.sock');
    const { port, databaseDirectory } = serverOptions();
    const bind = process.env.TUNARR_BIND_ADDR;
    const host =
      !bind || bind === '0.0.0.0'
        ? '127.0.0.1'
        : bind === '::'
          ? '[::1]'
          : bind.includes(':')
            ? `[${bind}]`
            : bind;
    const proc = spawn('/usr/bin/python3', ['-E', '-s', '-B', entry], {
      env: {
        EXT_SOCKET: socket,
        EXT_DEFAULT_SOURCE: process.env.TUNARR_EXTENSION_SOURCE ?? '',
        EXT_MANAGE: manage ? '1' : '0',
        STATE_DIR: join(databaseDirectory, 'extension-store'),
        TUNARR_URL: `http://${host}:${port}`,
        ...(user && password
          ? {
              TUNARR_BASIC_AUTH_USER: user,
              TUNARR_BASIC_AUTH_PASSWORD: password,
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child = proc;
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => proc.kill(), 8000);
      proc.stdout.once('data', (message: Buffer) => {
        if (message.toString().trim() === 'ready') {
          clearTimeout(timer);
          resolve(socket);
        } else proc.kill();
      });
      proc.once('error', reject);
      proc.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Extension host stopped'));
        if (child === proc) {
          child = undefined;
          starting = undefined;
        }
        void rm(directory, { recursive: true, force: true }).catch(
          (err: unknown) =>
            app.log.warn(
              { err },
              'Could not remove extension socket directory',
            ),
        );
      });
    });
    if (closing) proc.kill();
    return ready;
  }

  app.addHook('onClose', (_instance, closeDone) => {
    closing = true;
    child?.kill();
    closeDone();
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8192 },
    (_req, body, done) => done(null, body),
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/extensions/*',
    bodyLimit: 8192,
    schema: { hide: true },
    config: { disableRequestLogging: true },
    handler: async (req, reply) => {
      const path = req.raw.url ?? '';
      if (!manage && (req.method !== 'GET' || path !== '/extensions/')) {
        return reply
          .code(403)
          .send(
            'Store management requires Tunarr Basic Auth or TUNARR_EXTENSION_TRUSTED_LAN=true.',
          );
      }
      const post = req.method === 'POST';
      if (post) {
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (
          !host ||
          (origin !== `http://${host}` && origin !== `https://${host}`)
        )
          return reply
            .code(403)
            .send('Open Settings → Extensions on this server to continue.');
        if (
          typeof req.body !== 'string' ||
          !req.headers['content-type']?.startsWith(
            'application/x-www-form-urlencoded',
          )
        )
          return reply.code(415).send('Submit the extension form.');
      }
      if (!entry)
        return reply
          .code(503)
          .type('text/plain')
          .send(
            'Extension support is available in the Tunarr release container.',
          );
      try {
        starting ??= start().catch((err: unknown) => {
          starting = undefined;
          throw err;
        });
        const socketPath = await starting;
        const body = post && typeof req.body === 'string' ? req.body : '';
        const upstream = await new Promise<IncomingMessage>(
          (resolve, reject) => {
            const proxy = request(
              {
                socketPath,
                method: req.method,
                path,
                headers: {
                  host: 'localhost',
                  accept:
                    req.headers.accept === 'application/json'
                      ? 'application/json'
                      : 'text/html',
                  ...(post
                    ? {
                        'content-type': 'application/x-www-form-urlencoded',
                        'content-length': Buffer.byteLength(body),
                        origin: 'http://localhost',
                      }
                    : {}),
                },
              },
              resolve,
            );
            proxy.setTimeout(90000, () =>
              proxy.destroy(new Error('Extension request timed out')),
            );
            proxy.on('error', reject);
            proxy.end(body);
          },
        );
        for (const header of [
          'content-type',
          'cache-control',
          'referrer-policy',
          'x-content-type-options',
          'content-security-policy',
        ]) {
          const value = upstream.headers[header];
          if (value) reply.header(header, value);
        }
        return reply.code(upstream.statusCode ?? 502).send(upstream);
      } catch {
        return reply
          .code(503)
          .type('text/plain')
          .send(
            'Extension host unavailable. Reopen Settings → Extensions to retry.',
          );
      }
    },
  });
  done();
};
