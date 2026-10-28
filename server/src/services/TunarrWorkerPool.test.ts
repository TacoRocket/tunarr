import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// container.ts and TunarrWorkerPool.ts import each other. Entering the graph at
// the pool leaves the class in its temporal dead zone when the container tries
// to bind it, so the container has to be the entry point.
import '../container.ts';
import { TunarrWorkerPool } from './TunarrWorkerPool.ts';
import type { TunarrSubprocessService } from './TunarrSubprocessService.ts';

class FakeWorker extends EventEmitter {
  // Replies to every request unless told to hang, which stands in for a worker
  // stuck in a loop it never leaves.
  hang = false;
  postMessage = vi.fn((request: { requestId: string }) => {
    if (this.hang) {
      return;
    }
    setImmediate(() =>
      this.emit('message', {
        type: 'success',
        requestId: request.requestId,
        data: { type: 'status', status: 'healthy' },
      }),
    );
  });
  terminate = vi.fn(() => {
    this.emit('exit', 0);
    return Promise.resolve(0);
  });

  announceReady() {
    this.emit('message', { type: 'event', eventType: 'started' });
  }
}

/**
 * The pool attaches its listeners synchronously after `createWorker` returns,
 * so a worker can only report ready on a later tick.
 */
function makeSubprocessService() {
  const created: FakeWorker[] = [];
  let readyOnSpawn = true;
  let hangOnSpawn = false;

  const createWorker = vi.fn(() => {
    const worker = new FakeWorker();
    worker.hang = hangOnSpawn;
    created.push(worker);
    if (readyOnSpawn) {
      setImmediate(() => worker.announceReady());
    }
    return worker;
  });

  return {
    created,
    service: { createWorker } as unknown as TunarrSubprocessService,
    createWorker,
    set spawnBusy(value: boolean) {
      hangOnSpawn = value;
    },
    set spawnHealthy(value: boolean) {
      readyOnSpawn = value;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => vi.stubEnv('TUNARR_WORKER_IDLE_TIMEOUT_MS', '0'));
afterEach(() => vi.unstubAllEnvs());

describe('TunarrWorkerPool', () => {
  /**
   * `start()` guarded on `#state !== 'pending'` and then assigned
   * `#state = 'pending'` — it rewrote the one value that passes the check as
   * itself, so the "already starting" state was never entered. `#state` only
   * became 'started' inside the `.then()` of the `Promise.all`, an await
   * boundary later, leaving a window in which a second `start()` built a whole
   * second set of workers over the first: the originals were orphaned while
   * `queueTask` round-robined over a half-replaced pool.
   */
  test('a second start() while the first is in flight does not build a second pool', async () => {
    const once = makeSubprocessService();
    const poolOnce = new TunarrWorkerPool(once.service);
    poolOnce.start();
    await poolOnce.allReady();
    const expected = once.createWorker.mock.calls.length;
    expect(expected).toBeGreaterThan(0);

    const twice = makeSubprocessService();
    const poolTwice = new TunarrWorkerPool(twice.service);
    poolTwice.start();
    poolTwice.start();
    await poolTwice.allReady();

    expect(twice.createWorker).toHaveBeenCalledTimes(expected);
  });

  /**
   * `#startPromises` was only ever pushed to, never reset. After a failed
   * startup and a shutdown, a fresh `start()` appended to the same array, so
   * `allReady()` kept awaiting — and re-throwing — the previous run's already
   * terminated workers.
   */
  test('a fresh start() does not await the previous run of workers', async () => {
    const subprocess = makeSubprocessService();
    subprocess.spawnHealthy = false;
    const pool = new TunarrWorkerPool(subprocess.service);

    pool.start();
    await tick();
    subprocess.created.forEach((worker) => worker.emit('exit', 1));
    await expect(pool.allReady()).rejects.toThrow();

    await pool.shutdown(100);

    subprocess.spawnHealthy = true;
    pool.start();

    await expect(pool.allReady()).resolves.toBeUndefined();
  });

  /**
   * A failed startup went to `console.error` rather than the logger, so it was
   * absent from the log files that users actually send in.
   */
  test('a failed startup is reported through the logger, not console', async () => {
    const subprocess = makeSubprocessService();
    subprocess.spawnHealthy = false;
    const pool = new TunarrWorkerPool(subprocess.service);

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    pool.start();
    await tick();
    subprocess.created.forEach((worker) => worker.emit('exit', 1));
    await expect(pool.allReady()).rejects.toThrow();
    await tick();

    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
    await pool.shutdown(100);
  });
});

describe('TunarrWorkerPool task timeouts', () => {
  const pools: TunarrWorkerPool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.shutdown(100)));
  });

  async function startedPool() {
    const subprocess = makeSubprocessService();
    const pool = new TunarrWorkerPool(subprocess.service);
    pools.push(pool);
    pool.start();
    await pool.allReady();
    const [first] = subprocess.created;
    if (first === undefined) {
      throw new Error('The pool started no workers');
    }
    return { subprocess, pool, first };
  }

  test('a timed-out task frees its worker for later tasks', async () => {
    const { subprocess, pool, first } = await startedPool();
    const workerCount = subprocess.created.length;
    first.hang = true;

    await expect(pool.queueTask({ type: 'status' }, 50)).rejects.toThrow(
      /timeout/i,
    );

    // One task per slot, so the timed-out worker's slot is used again.
    for (let i = 0; i < workerCount; i++) {
      await expect(pool.queueTask({ type: 'status' }, 5_000)).resolves.toEqual({
        type: 'status',
        status: 'healthy',
      });
    }

    expect(first.terminate).toHaveBeenCalledTimes(1);
    expect(subprocess.createWorker).toHaveBeenCalledTimes(workerCount + 1);
  }, 15_000);

  test('tasks queued behind a timed-out task are released', async () => {
    const { subprocess, pool, first } = await startedPool();
    const workerCount = subprocess.created.length;
    first.hang = true;

    // Round-robin from slot 0 puts `timedOut` on the hung worker, `others` on
    // the remaining slots, and `queuedBehind` back on the hung worker.
    const timedOut = pool.queueTask({ type: 'status' }, 50);
    const others = Array.from({ length: workerCount - 1 }, () =>
      pool.queueTask({ type: 'status' }, 5_000),
    );
    const queuedBehind = pool.queueTask({ type: 'status' }, 10_000);

    await Promise.all([
      expect(timedOut).rejects.toThrow(/timeout/i),
      expect(queuedBehind).rejects.toThrow(/exited/i),
      expect(Promise.all(others)).resolves.toHaveLength(workerCount - 1),
    ]);
    expect(first.postMessage).toHaveBeenCalledTimes(2);
  }, 10_000);

  test('shutdown after replacing a timed-out worker starts no further workers', async () => {
    const { subprocess, pool, first } = await startedPool();
    const workerCount = subprocess.created.length;
    first.hang = true;
    await expect(pool.queueTask({ type: 'status' }, 50)).rejects.toThrow(
      /timeout/i,
    );
    await vi.waitFor(
      () =>
        expect(subprocess.createWorker).toHaveBeenCalledTimes(workerCount + 1),
      { timeout: 3_000 },
    );
    const replacement = subprocess.created.at(-1);

    await pool.shutdown(100);
    await tick();

    expect(subprocess.createWorker).toHaveBeenCalledTimes(workerCount + 1);
    expect(replacement?.terminate).toHaveBeenCalled();
  });
});

describe('TunarrWorkerPool on-demand lifecycle', () => {
  test('shutdown cancels a cold job instead of dispatching it after restart', async () => {
    vi.stubEnv('TUNARR_WORKER_IDLE_TIMEOUT_MS', '60');
    const subprocess = makeSubprocessService();
    subprocess.spawnHealthy = false;
    const pool = new TunarrWorkerPool(subprocess.service);
    try {
      pool.start();
      const job = pool.queueTask({ type: 'status' });
      const result = expect(job).rejects.toThrow();
      await tick();
      await pool.shutdown(100);
      subprocess.spawnHealthy = true;
      pool.start();
      await result;
      expect(subprocess.created).toHaveLength(1);
    } finally {
      await pool.shutdown(100);
    }
  });

  test('allocates for work, retires idle workers, and recreates for the next job', async () => {
    vi.stubEnv('TUNARR_WORKER_IDLE_TIMEOUT_MS', '30');
    const subprocess = makeSubprocessService();
    const pool = new TunarrWorkerPool(subprocess.service);
    try {
      pool.start();
      pool.start();
      await pool.allReady();
      expect(subprocess.created).toHaveLength(0);
      subprocess.spawnBusy = true;
      const jobs = [
        pool.queueTask({ type: 'status' }),
        pool.queueTask({ type: 'status' }),
      ];
      await vi.waitFor(() => expect(subprocess.created).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (const worker of subprocess.created) {
        expect(worker.terminate).not.toHaveBeenCalled();
        const request = worker.postMessage.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        worker.emit('message', {
          type: 'success',
          requestId: request?.requestId,
          data: { type: 'status', status: 'healthy' },
        });
      }
      await expect(Promise.all(jobs)).resolves.toHaveLength(2);
      await vi.waitFor(() => {
        for (const worker of subprocess.created)
          expect(worker.terminate).toHaveBeenCalledTimes(1);
      });
      // Retiring a worker must not trigger the crash-replacement timer.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(subprocess.created).toHaveLength(2);
      subprocess.spawnBusy = false;
      await expect(pool.queueTask({ type: 'status' })).resolves.toEqual({
        type: 'status',
        status: 'healthy',
      });
      expect(subprocess.created).toHaveLength(3);
    } finally {
      await pool.shutdown(100);
    }
  });
});
