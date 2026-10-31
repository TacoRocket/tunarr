import { inject, injectable } from 'inversify';
import type { StrictOmit } from 'ts-essentials';
import { match } from 'ts-pattern';
import type { z } from 'zod/v4';
import type {
  IWorkerPool,
  WorkerTaskOptions,
} from '../interfaces/IWorkerPool.ts';

import type {
  WorkerRequest,
  WorkerRequestToResponse,
} from '../types/worker_schemas.ts';
import { USE_WORKER_POOL_ENV_VAR } from '../util/env.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { SlotSchedulerService } from './scheduling/RandomSlotSchedulerService.ts';
import { TimeSlotSchedulerService } from './scheduling/TimeSlotSchedulerService.ts';
import { TunarrWorkerPool } from './TunarrWorkerPool.ts';

type OutTypes = typeof WorkerRequestToResponse;

/**
 * Runs scheduling inline; OCR always needs an isolated, terminable worker.
 */
@injectable()
export class NoopWorkerPool implements IWorkerPool {
  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(TimeSlotSchedulerService)
    private timeSlotSchedulerService: TimeSlotSchedulerService,
    @inject(SlotSchedulerService)
    private slotSchedulerService: SlotSchedulerService,
    @inject(TunarrWorkerPool) private ocrWorkerPool: TunarrWorkerPool,
  ) {}

  start(): void {
    this.ocrWorkerPool.start({ scheduling: false });
    this.logger.debug(
      'Running scheduling inline; OCR uses an exclusive worker. Set %s to true for scheduling workers',
      USE_WORKER_POOL_ENV_VAR,
    );
  }

  async shutdown(timeout: number): Promise<void> {
    await this.ocrWorkerPool.shutdown(timeout);
  }

  allReady(): Promise<void> {
    return Promise.resolve(void 0);
  }

  async queueTask<
    Req extends StrictOmit<WorkerRequest, 'requestId'>,
    Out = z.infer<(typeof WorkerRequestToResponse)[Req['type']]>,
  >(
    request: Req,
    timeout = 60_000,
    options: WorkerTaskOptions = {},
  ): Promise<Out> {
    options.signal?.throwIfAborted();
    if (options.signal && request.type !== 'pgs-ocr')
      throw new Error('Cooperative cancellation is only supported for PGS OCR');
    return (
      match(request as WorkerRequest)
        .with({ type: 'pgs-ocr' }, (request) =>
          this.ocrWorkerPool.queueTask(request, timeout, options),
        )
        // .returnType<Promise<Out>>()
        .with({ type: 'status' }, () =>
          Promise.resolve<Out>({
            status: 'healthy',
            type: 'status',
          } as Out),
        )
        .with({ type: 'restart' }, () => {
          return Promise.resolve<Out>(void 0 as Out);
        })
        .with({ type: 'time-slots' }, async ({ request, type }) => {
          const result = await this.timeSlotSchedulerService.schedule(request);
          return {
            result,
            type,
          } satisfies z.infer<OutTypes[typeof type]>;
        })
        .with({ type: 'schedule-slots' }, async ({ request, type }) => {
          const result = await this.slotSchedulerService.schedule(request);

          return {
            result,
            type,
          };
        })
        .exhaustive() as Promise<Out>
    );
  }
}
