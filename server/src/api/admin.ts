import { z } from 'zod/v4';
import type { RouterPluginCallback } from '@/types/serverType.js';
import {
  isSameOriginWrite,
  type AdminAccess,
} from '../services/AdminAccess.ts';

const ok = { ok: true } as const;
const done = z.object({ ok: z.literal(true) });
const error = z.object({ message: z.string() });
const response = {
  200: done,
  400: error,
  401: error,
  403: error,
  409: error,
  429: error,
};
const tags = ['Admin'];
const account = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
const empty = z.object({}).strict();
const codeRoute = {
  tags,
  body: empty,
  response: { ...response, 200: done.extend({ setupCodePath: z.string() }) },
};
const claimRoute = {
  tags,
  body: account.extend({ code: z.string().min(1).max(128) }),
  response,
};
const credentialsRoute = { tags, body: account, response };
const emptyRoute = { tags, body: empty, response };

export const adminRouter: RouterPluginCallback<{ access: AdminAccess }> = (
  app,
  { access },
  next,
) => {
  app.addHook('onRoute', (route) => {
    route.config = { ...route.config, authRequired: false };
    route.bodyLimit = 256 * 1024;
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isSameOriginWrite(req))
      return reply.code(403).send({
        message: 'Open Tunarr directly to manage administrator access.',
      });
  });

  app.get(
    '/',
    {
      schema: {
        tags,
        response: {
          200: z.object({
            mode: z.enum(['setup', 'saved', 'environment', 'damaged']),
            signedIn: z.boolean(),
            trustedLan: z.boolean(),
          }),
        },
      },
    },
    (req, reply) =>
      void reply.send({
        mode: access.mode,
        signedIn: access.signedIn(req),
        trustedLan: access.trustedLan,
      }),
  );

  app.post('/setup-code', { schema: codeRoute }, async (_req, reply) => {
    if (access.mode !== 'setup')
      return reply
        .code(409)
        .send({ message: 'Administrator access is already configured.' });
    await access.credentials.requestSetupCode();
    return { ...ok, setupCodePath: access.credentials.setupCodePath };
  });

  app.post('/setup', { schema: claimRoute }, async (req, reply) => {
    if (access.mode !== 'setup')
      return reply
        .code(409)
        .send({ message: 'Administrator access is already configured.' });
    const { code, username, password } = req.body;
    await access.credentials.claim(code, username, password);
    access.signIn(req, reply);
    return ok;
  });

  app.post('/login', { schema: credentialsRoute }, async (req, reply) => {
    if (
      access.mode !== 'saved' ||
      !(await access.credentials.verify(req.body.username, req.body.password))
    )
      return reply
        .code(401)
        .send({ message: 'Incorrect username or password.' });
    access.signIn(req, reply);
    return ok;
  });

  app.post('/logout', { schema: emptyRoute }, (req, reply) => {
    access.signOut(req, reply);
    void reply.send(ok);
  });

  app.post('/recovery-code', { schema: codeRoute }, async (_req, reply) => {
    if (access.mode !== 'saved' && access.mode !== 'damaged')
      return reply
        .code(409)
        .send({ message: 'There is no saved login to recover.' });
    await access.credentials.requestRecoveryCode();
    return { ...ok, setupCodePath: access.credentials.setupCodePath };
  });

  app.post('/recover', { schema: claimRoute }, async (req, reply) => {
    if (access.mode !== 'saved' && access.mode !== 'damaged')
      return reply
        .code(409)
        .send({ message: 'There is no saved login to recover.' });
    const { code, username, password } = req.body;
    await access.credentials.recover(code, username, password);
    access.signIn(req, reply);
    return ok;
  });
  next();
};
