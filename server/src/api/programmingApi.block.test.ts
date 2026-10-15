import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { expect, it } from 'vitest';
import { programmingApi } from './programmingApi.ts';

it('returns the invalid block UUID message instead of failing error serialization', async () => {
  const app = Fastify()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    .withTypeProvider<ZodTypeProvider>();
  try {
    await app.register(programmingApi);
    const response = await app.inject({
      method: 'POST',
      url: '/programming/generate-block',
      payload: { entries: [{ type: 'program', programId: 'not-a-uuid' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('Invalid UUID');
  } finally {
    await app.close();
  }
});
