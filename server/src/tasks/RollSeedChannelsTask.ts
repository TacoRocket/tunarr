import { inject, injectable } from 'inversify';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { MeilisearchService } from '../services/MeilisearchService.ts';
import { KEYS } from '../types/inject.ts';
import type { GrowSeedChannelTask } from './GrowSeedChannelTask.ts';
import { SimpleTask } from './Task.ts';

export const RollingSeedRefreshMinutes = 5;

/** Periodic refills share the same channel lock and publisher as viewing-triggered growth. */
@injectable()
export class RollSeedChannelsTask extends SimpleTask {
  static ID = RollSeedChannelsTask.name;
  constructor(
    @inject(KEYS.ChannelDB) private channels: IChannelDB,
    @inject(KEYS.SeedChannelGrowthTaskFactory)
    private growTask: () => GrowSeedChannelTask,
    @inject(KEYS.SearchService)
    private search: Pick<MeilisearchService, 'waitUntilReady'>,
  ) {
    super();
  }

  protected async runInternal() {
    // Startup dispatches this job in the background before search starts.
    await this.search.waitUntilReady();
    const failures: string[] = [];
    for (const channel of await this.channels.getAllChannels()) {
      const result = await this.growTask().run({ channelId: channel.uuid });
      if (result.isFailure()) failures.push(channel.uuid);
    }
    // A failed channel keeps its previous lineup; other channels still get their refill.
    if (failures.length)
      throw new Error(
        `Rolling guide refill failed for channels: ${failures.join(', ')}`,
      );
  }
}
