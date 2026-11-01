import { Mutex } from 'async-mutex';
import retry from 'async-retry';
import { inject, injectable } from 'inversify';
import { reject } from 'lodash-es';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Worker } from 'node:worker_threads';
import type { StrictOmit } from 'ts-essentials';
import { match, P } from 'ts-pattern';
import { v4 } from 'uuid';
import type z from 'zod/v4';
import type {
  IWorkerPool,
  WorkerTaskOptions,
} from '../interfaces/IWorkerPool.ts';
import { ScheduleValidationError } from '../types/errors.ts';

import type {
  WorkerRequest,
  WorkerRequestToResponse,
} from '../types/worker_schemas.ts';
import { WorkerMessage } from '../types/worker_schemas.ts';
import {
  getNumericEnvVar,
  WORKER_IDLE_TIMEOUT_ENV_VAR,
  WORKER_POOL_SIZE_ENV_VAR,
} from '../util/env.ts';
import { timeoutPromise } from '../util/index.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { TunarrSubprocessService } from './TunarrSubprocessService.ts';

const MAX_WORKERS = 8;

const cpuCount = cpus().length;

const envVarSetting = getNumericEnvVar(WORKER_POOL_SIZE_ENV_VAR);

const numWorkers = envVarSetting ?? Math.min(cpuCount, MAX_WORKERS);
// An exclusive OCR slot preserves scheduling capacity even with one worker.
const OCR_WORKER_INDEX = numWorkers;
const OCR_CANCEL_GRACE_MS = 30_000;
const OCR_IDLE_TIMEOUT_MS = 60_000;

// A worker that dies is respawned, but a worker that cannot start at all —
// a broken bundle, a bad entry path — would otherwise be respawned in a tight
// loop forever. Back off, and give up rather than spin.
const MAX_CONSECUTIVE_RESTARTS = 5;
const RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;

interface PooledWorker {
  worker: Worker;
  ready: boolean;
  retiring: boolean;
  idleTimer?: NodeJS.Timeout;
}

class Future<T> implements Promise<T> {
  #promise: Promise<T>;
  #resolve!: (v: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;
  #state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  #value: T | undefined;
  #err: unknown;

  constructor() {
    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });

    this.#promise.then(
      (v) => {
        this.#state = 'fulfilled';
        this.#value = v;
      },
      (err) => {
        this.#state = 'rejected';
        this.#err = err;
      },
    );
  }

  [Symbol.toStringTag]!: string;

  resolve(value: T | PromiseLike<T>) {
    if (this.#state === 'pending') {
      this.#resolve(value);
    } else {
      throw new Error(
        'Resolving already fulfilled future with state ' + this.#state,
      );
    }
  }

  reject(e: unknown) {
    if (this.#state === 'pending') {
      this.#reject(e);
    } else {
      throw new Error(
        'Rejecting already fulfilled future with state ' + this.#state,
      );
    }
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.#promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onfinally);
  }

  get promise() {
    return this.#promise;
  }

  get state() {
    return this.#state;
  }

  get value() {
    return this.#value;
  }

  get error() {
    return this.#err;
  }
}

type State = 'pending' | 'starting' | 'started' | 'terminating';

@injectable()
export class TunarrWorkerPool implements IWorkerPool {
  #mu = new Mutex();
  #state: State = 'pending';
  #pool: (PooledWorker | undefined)[] = Array<PooledWorker | undefined>(
    numWorkers + 1,
  ).fill(undefined);
  #consecutiveRestarts: number[] = Array<number>(numWorkers + 1).fill(0);
  #last = 0;
  #listeners = new Map<string, Future<unknown>>();
  #cancellations = new Map<string, () => void>();
  #progress = new Map<string, (message: string) => void>();
  #outstandingByIndex = new Map<number, string[]>();
  #startPromises: Promise<boolean>[] = [];
  #startRequested = new Future<void>();
  #restartTimers = new Map<number, NodeJS.Timeout>();
  #generation = 0;
  readonly #idleTimeout = Math.max(
    0,
    getNumericEnvVar(WORKER_IDLE_TIMEOUT_ENV_VAR) ?? 0,
  );

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(TunarrSubprocessService)
    private subprocessService: TunarrSubprocessService,
  ) {}

  start(options: { scheduling?: boolean } = {}) {
    if (this.#state !== 'pending') {
      return;
    }
    // Not 'pending' — that is the value just tested for, so assigning it back
    // left the guard inert and the "already starting" state unreachable. The
    // pool only reached 'started' an await boundary later, and a second
    // start() inside that window built an entire second set of workers over
    // the first: the originals were orphaned while queueTask round-robined
    // over a half-replaced pool.
    this.#state = 'starting';
    const generation = ++this.#generation;
    this.#consecutiveRestarts.fill(0);
    this.logger.info('Starting worker pool...');
    if (this.#idleTimeout > 0 || options.scheduling === false) {
      this.#startPromises = [];
      this.#state = 'started';
      this.#startRequested.resolve();
      this.logger.info(
        'Worker pool starts on demand, up to %d scheduling workers plus one exclusive OCR worker, idle timeout %d ms',
        numWorkers,
        this.#idleTimeout,
      );
      return;
    }
    // Replaced rather than appended to. Pushing meant a pool restarted after
    // a shutdown kept the previous run's promises, so allReady() awaited —
    // and re-threw for — workers that had already been terminated.
    const startPromises = new Array<Promise<boolean>>();
    for (let i = 0; i < numWorkers; i++) {
      startPromises.push(this.setupWorker(i));
    }
    this.#startPromises = startPromises;
    this.#startRequested.resolve();
    Promise.all(startPromises)
      .then(() => {
        if (generation !== this.#generation) return;
        this.logger.debug(
          'Worker pool successfully started %d workers',
          numWorkers,
        );
        this.#state = 'started';
      })
      .catch((err: unknown) => {
        // Deliberately not reset to 'pending'. Some workers may have come up,
        // and a second start() over them would orphan those. shutdown() is
        // the defined way back to a startable state.
        this.logger.error(
          err,
          'Worker pool failed to start all %d workers',
          numWorkers,
        );
      });
  }

  async shutdown(timeout: number = 5_000) {
    if (this.#state === 'terminating') {
      return;
    }
    this.#state = 'terminating';
    const cancellations = [...this.#cancellations.entries()];
    const canceledJobs = cancellations.map(([id, cancel]) => {
      cancel();
      return this.#listeners.get(id)?.promise ?? Promise.resolve();
    });
    if (canceledJobs.length > 0) {
      try {
        await timeoutPromise(Promise.allSettled(canceledJobs), timeout);
      } catch (error) {
        this.logger.warn(
          error,
          'OCR cleanup exceeded shutdown deadline; terminating workers',
        );
      }
    }
    this.#generation++;
    for (const timer of this.#restartTimers.values()) clearTimeout(timer);
    this.#restartTimers.clear();
    for (const pooled of this.#pool) {
      if (pooled) clearTimeout(pooled.idleTimer);
    }
    this.logger.info('Attempting graceful shutdown of all workers');
    const shutdownPromises = this.#pool.map((pooled) =>
      pooled ? pooled.worker.terminate() : Promise.resolve(0),
    );
    return timeoutPromise(
      Promise.all(shutdownPromises).then(() => {}),
      timeout,
    ).then(() => {
      this.#state = 'pending';
      this.#startRequested = new Future<void>();
    });
  }

  async allReady() {
    // Guide startup can request OCR before StartupService starts the pool.
    await this.#startRequested;
    await Promise.all(this.#startPromises);
    return;
  }

  async queueTask<
    Req extends StrictOmit<WorkerRequest, 'requestId'>,
    Out = z.infer<(typeof WorkerRequestToResponse)[Req['type']]>,
  >(
    request: Req,
    timeout: number = 60_000,
    options: WorkerTaskOptions = {},
  ): Promise<Out> {
    options.signal?.throwIfAborted();
    if (options.signal && request.type !== 'pgs-ocr')
      throw new Error('Cooperative cancellation is only supported for PGS OCR');
    const requestId = v4();
    const reqWithId: WorkerRequest = { ...request, requestId };
    const fut = new Future<Out>();
    const generation = this.#generation;
    const dispatch = () =>
      this.#mu.runExclusive(async () => {
        options.signal?.throwIfAborted();
        if (generation !== this.#generation) {
          throw new Error('Worker pool stopped before dispatch');
        }
        if (this.#state === 'pending' || this.#state === 'terminating') {
          throw new Error('Worker pool is not running');
        }
        const idx =
          request.type === 'pgs-ocr'
            ? OCR_WORKER_INDEX
            : this.#idleTimeout === 0
              ? this.#last
              : this.selectWorker();
        if (request.type !== 'pgs-ocr')
          this.#last = (this.#last + 1) % numWorkers;
        if (
          request.type === 'pgs-ocr' &&
          (this.#outstandingByIndex.get(idx)?.length ?? 0) > 0
        )
          throw new Error(
            'The OCR worker is busy; retry after its current job finishes',
          );
        if (
          (this.#idleTimeout > 0 || idx === OCR_WORKER_INDEX) &&
          this.#pool[idx] === undefined
        ) {
          const starting = this.setupWorker(idx);
          const startingWorker = this.#pool.at(idx);
          try {
            await timeoutPromise(starting, timeout);
          } catch (error) {
            if (startingWorker && this.#pool.at(idx) === startingWorker) {
              startingWorker.ready = false;
              await startingWorker.worker.terminate();
            }
            throw error;
          }
        }
        if (generation !== this.#generation) {
          throw new Error('Worker pool stopped before dispatch');
        }
        const pooled = this.#pool[idx];
        if (pooled === undefined) {
          throw new Error(`Worker at ${idx} has not been created yet`);
        }
        const { ready, worker } = pooled;
        if (ready && !pooled.retiring) {
          clearTimeout(pooled.idleTimer);
          this.logger.debug(
            'Schedule task type "%s" to worker index %d [request id = %s]',
            request.type,
            idx,
            requestId,
          );
          this.#listeners.set(reqWithId.requestId, fut as Future<unknown>);
          if (options.onProgress)
            this.#progress.set(requestId, options.onProgress);
          this.#outstandingByIndex.set(
            idx,
            this.#outstandingByIndex.get(idx)?.concat([requestId]) ?? [
              requestId,
            ],
          );
          performance.mark(requestId);
          worker.postMessage(reqWithId);
          return { idx, worker };
        } else {
          throw new Error(`Worker at ${idx} is not ready yet`);
        }
      });
    const { idx, worker } =
      request.type === 'pgs-ocr'
        ? await dispatch()
        : await retry(async (bail) =>
            dispatch().catch((error: unknown) => {
              if (generation !== this.#generation) {
                bail(new Error('Worker pool stopped before dispatch'));
                return undefined as never;
              }
              throw error;
            }),
          );

    let cancellation: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const cancel = (reason: Error) => {
      if (fut.state !== 'pending' || cancellation) return;
      cancellation = reason;
      worker.postMessage({ type: 'cancel', requestId });
      forceTimer = setTimeout(() => {
        cancellation = new Error(
          `${reason.message}; OCR worker did not acknowledge cancellation within ${OCR_CANCEL_GRACE_MS}ms`,
          { cause: reason },
        );
        this.timeOutTask(requestId, idx, worker, OCR_CANCEL_GRACE_MS);
      }, OCR_CANCEL_GRACE_MS);
    };
    const abort = () =>
      cancel(new Error('PGS OCR canceled', { cause: options.signal?.reason }));
    if (request.type === 'pgs-ocr') {
      this.#cancellations.set(requestId, abort);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted || this.#state === 'terminating') abort();
    }
    const timer = setTimeout(() => {
      if (request.type === 'pgs-ocr')
        cancel(new Error(`Timeout after ${timeout}ms`));
      else this.timeOutTask(requestId, idx, worker, timeout);
    }, timeout);
    return fut.promise
      .then(
        (result) => {
          if (cancellation) throw cancellation;
          return result;
        },
        (error: unknown) => {
          throw cancellation ?? error;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', abort);
        this.#cancellations.delete(requestId);
        this.#progress.delete(requestId);
        this.#listeners.delete(requestId);
        performance.clearMarks(requestId);
      });
  }

  private selectWorker(): number {
    let leastLoaded: number | undefined;
    let empty: number | undefined;
    for (let idx = 0; idx < numWorkers; idx++) {
      const pooled = this.#pool[idx];
      if (pooled === undefined) {
        if (
          !this.#restartTimers.has(idx) &&
          (this.#consecutiveRestarts[idx] ?? 0) <= MAX_CONSECUTIVE_RESTARTS
        ) {
          empty ??= idx;
        }
      } else if (pooled.ready && !pooled.retiring) {
        const outstanding = this.#outstandingByIndex.get(idx)?.length ?? 0;
        if (outstanding === 0) return idx;
        if (
          leastLoaded === undefined ||
          outstanding < (this.#outstandingByIndex.get(leastLoaded)?.length ?? 0)
        ) {
          leastLoaded = idx;
        }
      }
    }
    const selected = empty ?? leastLoaded;
    if (selected === undefined) throw new Error('No worker is available');
    return selected;
  }

  private retireWhenIdle(idx: number, pooled: PooledWorker) {
    clearTimeout(pooled.idleTimer);
    const idleTimeout =
      idx === OCR_WORKER_INDEX
        ? this.#idleTimeout || OCR_IDLE_TIMEOUT_MS
        : this.#idleTimeout;
    if (
      idleTimeout === 0 ||
      this.#state === 'terminating' ||
      (this.#outstandingByIndex.get(idx)?.length ?? 0) > 0
    )
      return;
    pooled.idleTimer = setTimeout(() => {
      if (
        this.#pool[idx] !== pooled ||
        pooled.retiring ||
        (this.#outstandingByIndex.get(idx)?.length ?? 0) > 0
      )
        return;
      pooled.retiring = true;
      pooled.ready = false;
      this.logger.info('Retiring idle worker %d', idx);
      pooled.worker.terminate().catch((error: unknown) => {
        this.logger.error(error, 'Failed to retire idle worker %d', idx);
      });
    }, idleTimeout).unref();
  }

  private timeOutTask(
    requestId: string,
    idx: number,
    worker: Worker,
    timeout: number,
  ) {
    const fut = this.#listeners.get(requestId);
    this.#listeners.delete(requestId);
    this.#outstandingByIndex.set(
      idx,
      reject(this.#outstandingByIndex.get(idx), (id) => id === requestId),
    );
    if (fut === undefined || fut.state !== 'pending') {
      return;
    }
    fut.reject(new Error(`Timeout after ${timeout}ms`));

    // A worker that misses its deadline may be stuck in a loop it cannot leave.
    // Terminating it frees the slot, and the exit handler rejects the worker's
    // other tasks and starts a replacement.
    const pooled = this.#pool[idx];
    if (pooled === undefined || pooled.worker !== worker) {
      return;
    }
    pooled.ready = false;
    this.logger.warn(
      'Worker %d missed the %d ms deadline for request %s. Replacing it.',
      idx,
      timeout,
      requestId,
    );
    worker.terminate().catch((err: unknown) => {
      this.logger.error(err, 'Failed to terminate worker %d', idx);
    });
  }

  private async setupWorker(idx: number): Promise<boolean> {
    if (this.#state === 'terminating') {
      this.logger.trace('Not starting worker because pool is terminating.');
      return Promise.resolve(false);
    }

    const generation = this.#generation;
    this.logger.info(`Starting worker ${idx}`);
    const worker = this.subprocessService.createWorker();

    const pooled: PooledWorker = { worker, ready: false, retiring: false };
    this.#pool[idx] = pooled;

    const fut = new Future<void>();
    let started = false;

    worker.on('message', (message) => {
      if (this.#pool[idx] !== pooled || generation !== this.#generation) return;
      const parsed = WorkerMessage.safeParse(message);
      if (parsed.error) {
        this.logger.warn(
          'Worker responded with broken reply: %s',
          parsed.error.message,
        );
        return;
      }

      match(parsed.data)
        .with({ type: 'progress' }, ({ requestId, message }) => {
          this.#progress.get(requestId)?.(message);
        })
        .with({ type: 'event', eventType: 'started' }, () => {
          // We should only ever get one of these
          this.logger.debug('Worker %d is ready', idx);
          started = true;
          this.#consecutiveRestarts[idx] = 0;
          pooled.ready = true;
          this.retireWhenIdle(idx, pooled);
          fut.resolve();
        })
        .with({ type: P.union('success', 'error') }, (reply) => {
          this.logger.debug(
            'Request id %s took %d ms',
            reply.requestId,
            this.consumeRequestTiming(reply.requestId),
          );
          const fut = this.#listeners.get(reply.requestId);
          if (fut) {
            this.#listeners.delete(reply.requestId);
            this.#outstandingByIndex.set(
              idx,
              reject(
                this.#outstandingByIndex.get(idx),
                (id) => id === reply.requestId,
              ),
            );
            if (reply.type === 'success') {
              fut.resolve(reply.data);
            } else {
              fut.reject(
                reply.httpCode === 400
                  ? new ScheduleValidationError(reply.message)
                  : new Error(reply.message),
              );
            }
          } else {
            this.logger.debug(
              'No listener found for request ID %s. The request may have timed out.',
              reply.requestId,
            );
          }
          this.retireWhenIdle(idx, pooled);
        })
        .exhaustive();
    });

    worker.on('error', (err) => {
      if (this.#pool[idx] !== pooled) return;
      this.logger.error(err, 'Worker %d errored out', idx);
      if (!started) {
        fut.reject(err);
      }

      const outstandingListeners = this.#outstandingByIndex.get(idx) ?? [];
      for (const outstanding of outstandingListeners) {
        this.#listeners.get(outstanding)?.reject(err);
      }

      this.#outstandingByIndex.set(idx, []);
    });

    worker.on('exit', (code) => {
      clearTimeout(pooled.idleTimer);
      if (this.#pool[idx] !== pooled) return;
      this.#pool[idx] = undefined;
      if (
        idx !== OCR_WORKER_INDEX &&
        !pooled.retiring &&
        generation === this.#generation
      ) {
        this.scheduleRestart(idx, code);
      }

      const outstandingListeners = this.#outstandingByIndex.get(idx) ?? [];
      for (const outstanding of outstandingListeners) {
        const fut = this.#listeners.get(outstanding);
        if (fut?.state === 'pending') {
          fut.reject(new Error('Worker exited'));
        }
      }
      this.#outstandingByIndex.set(idx, []);

      if (!started && fut.state === 'pending') {
        fut.reject(new Error('Worker exited with code ' + code));
      }
    });

    await fut;
    return true;
  }

  /**
   * Respawns a dead worker with exponential backoff, giving up after repeated
   * immediate failures.
   *
   * Without the backoff a worker that cannot start at all — a bad entry path in
   * a bundled build, say — is respawned as fast as the process can fork,
   * saturating a core and flooding the log.
   */
  private scheduleRestart(idx: number, exitCode: number) {
    if (this.#state === 'terminating') {
      this.logger.debug('Worker %d exited during shutdown.', idx);
      return;
    }

    const attempts = (this.#consecutiveRestarts[idx] ?? 0) + 1;
    this.#consecutiveRestarts[idx] = attempts;

    if (attempts > MAX_CONSECUTIVE_RESTARTS) {
      this.logger.error(
        'Worker %d exited (code = %d) and failed to start %d times in a row. Giving up on this worker.',
        idx,
        exitCode,
        MAX_CONSECUTIVE_RESTARTS,
      );
      return;
    }

    const delay = Math.min(
      RESTART_BACKOFF_MS * Math.pow(2, attempts - 1),
      MAX_RESTART_BACKOFF_MS,
    );

    this.logger.warn(
      'Worker %d exited (code = %d). Restarting in %d ms (attempt %d/%d).',
      idx,
      exitCode,
      delay,
      attempts,
      MAX_CONSECUTIVE_RESTARTS,
    );

    const generation = this.#generation;
    const timer = setTimeout(() => {
      if (this.#restartTimers.get(idx) !== timer) return;
      this.#restartTimers.delete(idx);
      if (
        this.#state === 'terminating' ||
        generation !== this.#generation ||
        this.#pool[idx] !== undefined
      ) {
        return;
      }
      this.setupWorker(idx).catch((err) => {
        this.logger.error(err, 'Failed to restart worker %d', idx);
      });
    }, delay).unref();
    this.#restartTimers.set(idx, timer);
  }

  /**
   * Returns how long a request took and clears its marks.
   *
   * Performance marks live on the global timeline until they are cleared, so
   * leaving one behind per request leaks for as long as the server runs.
   */
  private consumeRequestTiming(requestId: string): number {
    const [mark] = performance.getEntriesByName(requestId, 'mark');
    const duration = mark ? performance.now() - mark.startTime : 0;
    performance.clearMarks(requestId);
    return Math.round(duration);
  }
}
