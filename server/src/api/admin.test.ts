import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminAccess } from '../services/AdminAccess.ts';
import { AdminCredentials } from '../services/AdminCredentials.ts';
import { adminRouter } from './admin.ts';
import { HdhrApiRouter } from './hdhrApi.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tunarr-auth-routes-'));
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function start(environment?: { username: string; password: string }) {
  const credentials = new AdminCredentials(directory);
  await credentials.load();
  const access = new AdminAccess(credentials, environment, false);
  const app = Fastify()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    .withTypeProvider<ZodTypeProvider>();
  app.addHook('onRequest', access.authHook());
  app.register(adminRouter, { prefix: '/api/admin', access });
  app.register(new HdhrApiRouter().router);
  app.get('/web/settings', () => 'settings');
  return app;
}
async function codeFromFile() {
  const text = await readFile(join(directory, 'setup-code.txt'), 'utf8');
  const code = /^Code: (\S+)$/m.exec(text)?.[1];
  if (!code) throw new Error('Local code missing');
  return code;
}
function basic(user: string, password: string) {
  return {
    authorization:
      'Basic ' + Buffer.from(user + ':' + password).toString('base64'),
  };
}

it('applies the same route policy immediately after a claim as with environment credentials, which take precedence', async () => {
  const app = await start();
  const settings = '/web/settings';
  const open = '/lineup_status.json';
  const local = { username: 'owner', password: 'p' };
  const env = { username: 'operator', password: 'env' };
  expect((await app.inject(settings)).statusCode).toBe(200);
  await app.inject({
    method: 'POST',
    url: '/api/admin/setup-code',
    payload: {},
  });
  const claim = await app.inject({
    method: 'POST',
    url: '/api/admin/setup',
    payload: { ...local, code: await codeFromFile() },
  });
  expect(claim.statusCode).toBe(200);
  const cookie = claim.cookies[0]!;
  const session = { cookie: cookie.name + '=' + cookie.value };
  const envApp = await start(env);
  try {
    for (const [server, pair] of [
      [app, local],
      [envApp, env],
    ] as const) {
      const denied = await server.inject(settings);
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['www-authenticate']).toBe('Basic realm="Tunarr"');
      expect(
        (
          await server.inject({
            url: settings,
            headers: basic(pair.username, pair.password),
          })
        ).statusCode,
      ).toBe(200);
      expect((await server.inject(open)).statusCode).toBe(200);
    }
    expect(
      (await app.inject({ url: settings, headers: session })).statusCode,
    ).toBe(200);
    expect(
      (await envApp.inject({ url: settings, headers: session })).statusCode,
    ).toBe(401);
    expect(
      (
        await envApp.inject({
          url: settings,
          headers: basic(local.username, local.password),
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    await envApp.close();
  }
});
