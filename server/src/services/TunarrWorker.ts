import { inject, injectable } from 'inversify';
import PQueue from 'p-queue';
import { parentPort } from 'worker_threads';

import { TypedError, unwrapError } from '../types/errors.ts';
import { Result } from '../types/result.ts';
import type {
  WorkerReply,
  WorkerScheduleSlotsRequest,
  WorkerScheduleTimeSlotsRequest,
  WorkerSuccessReply,
  WorkerTimeSlotScheduleReply,
  WorkerPgsOcrRequest,
} from '../types/worker_schemas.ts';
import { WorkerInput, type WorkerEvent } from '../types/worker_schemas.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import { SlotSchedulerService } from './scheduling/RandomSlotSchedulerService.ts';
import { TimeSlotSchedulerService } from './scheduling/TimeSlotSchedulerService.ts';
import { MeilisearchService } from './MeilisearchService.ts';
import { prepareCachedPgsSubtitle } from './subtitles/PgsSubtitlePreparation.ts';

@injectable()
export class TunarrWorker {
  #queue: PQueue;
  #ocrJobs = new Map<string, AbortController>();

  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(TimeSlotSchedulerService)
    private timeSlotSchedulerService: TimeSlotSchedulerService,
    @inject(SlotSchedulerService)
    private slotSchedulerService: SlotSchedulerService,
    @inject(MeilisearchService) private searchService: MeilisearchService,
  ) {
    // How many tasks the worker pool can handle simultaneously
    // TODO: Make this configurable
    this.#queue = new PQueue({
      concurrency: 2,
    });
  }

  start() {
    this.logger.info('Tunarr worker started');
    parentPort?.postMessage({
      type: 'event',
      eventType: 'started',
      message: 'Worker successfully started!',
    } satisfies WorkerEvent);

    parentPort?.on('message', (message) => {
      const parsed = WorkerInput.safeParse(message);
      if (parsed.error) {
        this.logger.error(parsed.error, 'Error parsing worker request message');
        return;
      }

      if (parsed.data.type === 'cancel') {
        this.#ocrJobs.get(parsed.data.requestId)?.abort();
        return;
      }
      if (parsed.data.type === 'pgs-ocr') {
        this.queueOcr(parsed.data);
        return;
      }
      const request = parsed.data;

      this.#queue
        .add(async () => {
          const requestId = request.requestId;

          switch (request.type) {
            case 'status':
              this.sendSuccessReply(requestId, {
                type: 'status',
                status: 'healthy',
              });
              break;
            case 'time-slots':
              return this.handleTimeSlots(request);
            case 'schedule-slots':
              return this.handleSlots(request);
            case 'restart':
              process.exit(request.code ?? 1);
          }
        })
        .catch(console.error);
    });
  }

  private queueOcr(request: WorkerPgsOcrRequest) {
    const controller = new AbortController();
    this.#ocrJobs.set(request.requestId, controller);
    let running = false;
    controller.signal.addEventListener(
      'abort',
      () => {
        if (!running) {
          this.#ocrJobs.delete(request.requestId);
          this.replyWithError(
            request.requestId,
            new Error('PGS OCR canceled before starting'),
          );
        }
      },
      { once: true },
    );
    this.#queue
      .add(async () => {
        // PQueue checks a queued signal only when capacity becomes available.
        // Reply to queued cancellation above; leave only this inert queue entry.
        if (controller.signal.aborted) return;
        running = true;
        try {
          const result = await prepareCachedPgsSubtitle({
            ...request.request,
            signal: controller.signal,
            onProgress: (message) =>
              parentPort?.postMessage({
                type: 'progress',
                requestId: request.requestId,
                message,
              }),
          });
          this.sendSuccessReply(request.requestId, { type: 'pgs-ocr', result });
        } finally {
          this.#ocrJobs.delete(request.requestId);
        }
      })
      .catch((error: unknown) => {
        this.replyWithError(
          request.requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  private async handleTimeSlots(req: WorkerScheduleTimeSlotsRequest) {
    const result = await Result.attemptAsync(async () => {
      await this.searchService.start();
      return this.timeSlotSchedulerService.schedule(req.request);
    });

    if (result.isFailure()) {
      this.replyWithError(req.requestId, result.error);
      return;
    }

    this.sendSuccessReply(req.requestId, {
      result: result.get(),
      type: 'time-slots',
    } satisfies WorkerTimeSlotScheduleReply);
  }

  private async handleSlots(req: WorkerScheduleSlotsRequest) {
    const result = await Result.attemptAsync(async () => {
      await this.searchService.start();
      return this.slotSchedulerService.schedule(req.request);
    });

    if (result.isFailure()) {
      this.replyWithError(req.requestId, result.error);
      return;
    }

    this.sendSuccessReply(req.requestId, {
      result: result.get(),
      type: 'schedule-slots',
    });
  }

  private sendSuccessReply(
    requestId: string,
    data: WorkerSuccessReply['data'],
  ) {
    this.sendReply({
      type: 'success',
      data,
      requestId,
    });
  }

  private replyWithError(requestId: string, wrapped: Error) {
    const error = unwrapError(wrapped);
    this.logger.error(error);
    this.sendReply({
      type: 'error',
      requestId,
      message: error.message,
      httpCode: error instanceof TypedError ? error.httpCode : undefined,
    });
  }

  private sendReply(reply: WorkerReply) {
    parentPort?.postMessage(reply);
  }
}
