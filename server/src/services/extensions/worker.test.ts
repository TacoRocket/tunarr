import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';

it('keeps only accepted writes when an adapter catches storage quota errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'extension-quota-'));
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    execArgv: [],
    workerData: {
      storage: { kv: { existing: 'saved' }, dir, maxBytes: 1024 },
      deadline: Date.now() + 5000,
      input: {},
      code: `
        function run() {
          storage.set('accepted', 'ok');
          const errors = [];
          for (const key of ['new', 'existing']) {
            try {
              storage.set(key, 'x'.repeat(1024));
            } catch (error) {
              errors.push(error.message);
            }
          }
          return { errors, absent: storage.get('new') === null, preserved: storage.get('existing') === 'saved' };
        }
      `,
    },
  });
  try {
    const [reply] = await once(worker, 'message');
    expect(reply).toEqual({
      type: 'result',
      value: {
        errors: [
          expect.stringContaining('storage is full'),
          expect.stringContaining('storage is full'),
        ],
        absent: true,
        preserved: true,
      },
      writes: { kv: { existing: 'saved', accepted: 'ok' }, files: [] },
    });
  } finally {
    await worker.terminate();
    await rm(dir, { recursive: true, force: true });
  }
});
