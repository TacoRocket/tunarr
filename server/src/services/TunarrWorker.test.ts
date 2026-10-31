import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import '../container.ts';
import { TunarrWorker } from './TunarrWorker.ts';
import type { SlotSchedulerService } from './scheduling/RandomSlotSchedulerService.ts';
import type { TimeSlotSchedulerService } from './scheduling/TimeSlotSchedulerService.ts';
import type { MeilisearchService } from './MeilisearchService.ts';

const { port, prepare } = vi.hoisted(() => ({
  port: { on: vi.fn(), postMessage: vi.fn() },
  prepare: vi.fn(),
}));
vi.mock('worker_threads', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parentPort: port,
}));
vi.mock('./subtitles/PgsSubtitlePreparation.ts', () => ({
  prepareCachedPgsSubtitle: prepare,
}));

test('cancels queued OCR before running scheduling jobs release worker capacity', async () => {
  const release: Array<() => void> = [];
  const schedule = vi.fn(
    () => new Promise<void>((resolve) => release.push(resolve)),
  );
  const worker = new TunarrWorker(
    {} as TimeSlotSchedulerService,
    { schedule } as unknown as SlotSchedulerService,
    {
      start: vi.fn().mockResolvedValue(undefined),
    } as unknown as MeilisearchService,
  );
  worker.start();
  const receive = port.on.mock.calls.find(
    ([event]) => event === 'message',
  )?.[1];
  if (typeof receive !== 'function')
    throw new Error('Missing message receiver');
  const request = {
    type: 'schedule-slots',
    request: {
      type: 'programs',
      programIds: [],
      schedule: {
        type: 'random',
        flexPreference: 'end',
        maxDays: 0,
        padMs: 1,
        padStyle: 'slot',
        randomDistribution: 'none',
        lockWeights: false,
        slots: [],
      },
    },
  };
  receive({ ...request, requestId: randomUUID() });
  receive({ ...request, requestId: randomUUID() });
  await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
  const requestId = randomUUID();
  receive({
    type: 'pgs-ocr',
    requestId,
    request: {
      programId: 'test-program',
      inputPath: '/test/movie.mkv',
      revision: null,
      streamIndex: 2,
      forced: false,
      sdh: true,
      cacheFolder: '/test/cache',
    },
  });
  receive({ type: 'cancel', requestId });
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'error',
      requestId,
      message: 'PGS OCR canceled before starting',
    }),
  );
  expect(prepare).not.toHaveBeenCalled();
  release.forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  expect(prepare).not.toHaveBeenCalled();
});
