import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
import { AdminAccess } from '../services/AdminAccess.ts';
import { AdminCredentials } from '../services/AdminCredentials.ts';
import { extensionStoreRouter } from './extensionStore.ts';

vi.mock('../services/extensions/storeInstance.ts', () => ({
  extensionStore: () => ({
    lock: { runExclusive: <T>(fn: () => Promise<T>) => fn() },
    prepare: async () => {},
    installed: async () => [],
    act: async (
      _key: string,
      inputs: Record<string, string>,
      program: (id: string) => Promise<unknown>,
    ) => ({
      version: '1.0.0',
      result: { program: await program(inputs.program!) },
    }),
  }),
}));

it.each([
  { cookie: 'tunarr_admin=ticket' },
  { authorization: 'Basic dTpw' },
  {},
])(
  'forwards only supplied credentials to the program-picker read (%j)',
  async (credentials) => {
    const app = Fastify()
      .setValidatorCompiler(validatorCompiler)
      .setSerializerCompiler(serializerCompiler)
      .withTypeProvider<ZodTypeProvider>();
    const id = '11111111-1111-4111-8111-111111111111';
    const selected = {
      type: 'movie',
      identifiers: [{ type: 'tmdb', id: '42' }],
    };
    app.get('/api/programs/:id', (req) => {
      expect(req.headers.cookie).toBe(credentials.cookie);
      expect(req.headers.authorization).toBe(credentials.authorization);
      return selected;
    });
    app.register(extensionStoreRouter, {
      prefix: '/api/extensions',
      access: new AdminAccess(new AdminCredentials('unused'), undefined, true),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/extensions/actions/run',
        headers: credentials,
        payload: { key: 'adapter', action: 'lookup', inputs: { program: id } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.program).toEqual(selected);
    } finally {
      await app.close();
    }
  },
);
