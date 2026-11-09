import { expect, test, vi } from 'vitest';
import { Result } from '../types/result.ts';
import { RollSeedChannelsTask } from './RollSeedChannelsTask.ts';

vi.mock('../util/logging/LoggerFactory.ts', () => ({
  LoggerFactory: { root: { trace: vi.fn(), warn: vi.fn() } },
}));

test('the startup refill waits for the search index, then grows the guide', async () => {
  const ready = Promise.withResolvers<void>();
  const grow = vi.fn(async () => Result.void());
  const task = new RollSeedChannelsTask(
    { getAllChannels: async () => [{ uuid: 'rolling-channel' }] } as never,
    () => ({ run: grow }) as never,
    { waitUntilReady: () => ready.promise },
  );

  const refill = task.run(undefined);
  await Promise.resolve();
  expect(grow).not.toHaveBeenCalled();

  ready.resolve();
  expect((await refill).isSuccess()).toBe(true);
  expect(grow).toHaveBeenCalledExactlyOnceWith({
    channelId: 'rolling-channel',
  });
});
