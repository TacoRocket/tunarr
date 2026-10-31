import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { measureWithConcurrentProbe } from './probe.ts';

// A stall that ends just as the background work reports done leaves the probe
// it delayed still in flight. Summarizing before that probe returns reported
// zero probes and a 0 ms maximum, so the stall passed the latency limit.
test('includes the probe a stall delayed when the work settles immediately', async () => {
  const app = Fastify();
  app.get('/probe', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return { ok: true };
  });
  await app.ready();

  try {
    const { probe } = await measureWithConcurrentProbe({
      app,
      url: '/probe',
      settleMs: 100,
      settledWhen: () => true,
      // eslint-disable-next-line @typescript-eslint/require-await
      operation: async () => {
        const end = Date.now() + 300;
        while (Date.now() < end) {
          // Blocks the event loop, like the stalls this helper measures.
        }
      },
    });

    expect(probe.count).toBeGreaterThan(0);
    expect(probe.maxMs).toBeGreaterThanOrEqual(250);
  } finally {
    await app.close();
  }
});
