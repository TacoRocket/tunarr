import { describe, expect, test, vi } from 'vitest';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { IWorkerPool } from '../interfaces/IWorkerPool.ts';
import type { TVGuideService } from '../services/TvGuideService.ts';
import { RegenerateChannelLineupCommand } from './RegenerateChannelLineupCommand.ts';

vi.mock('../services/TvGuideService.ts', () => ({ TVGuideService: class {} }));

function setup(
  scheduleSeed?: number[],
  opts: { scheduleDetached?: boolean; saved?: boolean } = {},
) {
  const loadedItems = [{ type: 'content', id: 'old', durationMs: 100 }];
  const channelDB = {
    loadChannelAndLineupOrm: vi.fn().mockResolvedValue({
      channel: { uuid: 'ch1', startTime: 1000 },
      lineup: {
        items: loadedItems,
        schedule: { type: 'time', slots: [] },
        scheduleSeed,
        scheduleDetached: opts.scheduleDetached,
      },
    }),
    saveRegeneratedLineup: vi.fn().mockResolvedValue(opts.saved ?? true),
  };
  const queueTask = vi.fn().mockResolvedValue({
    result: {
      lineup: [{ type: 'content', id: 'p1', duration: 500 }],
      seed: [9, 9],
    },
  });
  const tvGuideService = {
    updateCachedChannel: vi.fn().mockResolvedValue(undefined),
  };

  const command = new RegenerateChannelLineupCommand(
    channelDB as unknown as IChannelDB,
    () => ({ queueTask }) as unknown as IWorkerPool,
    tvGuideService as unknown as TVGuideService,
  );
  return { command, channelDB, queueTask, tvGuideService, loadedItems };
}

describe('RegenerateChannelLineupCommand', () => {
  test('replays the stored seed', async () => {
    const { command, queueTask } = setup([1, 2, 3]);

    await command.execute({ channelId: 'ch1' });

    expect(queueTask).toHaveBeenCalledWith({
      type: 'time-slots',
      request: expect.objectContaining({ seed: [1, 2, 3], startTime: 1000 }),
    });
  });

  test('saves conditionally on the items it started from, with the new seed', async () => {
    const { command, channelDB, loadedItems } = setup();

    await command.execute({ channelId: 'ch1' });

    expect(channelDB.saveRegeneratedLineup).toHaveBeenCalledWith(
      'ch1',
      loadedItems,
      {
        items: [expect.objectContaining({ type: 'content', id: 'p1' })],
        scheduleSeed: [9, 9],
      },
    );
  });

  test('does not regenerate a detached lineup (#76)', async () => {
    const { command, channelDB, queueTask } = setup([1, 2, 3], {
      scheduleDetached: true,
    });

    await command.execute({ channelId: 'ch1' });

    expect(queueTask).not.toHaveBeenCalled();
    expect(channelDB.saveRegeneratedLineup).not.toHaveBeenCalled();
  });

  test('a refused save still refreshes the guide', async () => {
    const { command, tvGuideService } = setup(undefined, { saved: false });

    await command.execute({ channelId: 'ch1' });

    expect(tvGuideService.updateCachedChannel).toHaveBeenCalledWith(
      'ch1',
      true,
    );
  });
});
