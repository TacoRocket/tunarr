import { isNonEmptyString, seq } from '@tunarr/shared/util';
import type { CondensedChannelProgram } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { condensedProgramToLineupItem } from '../db/channel/lineupItemConversion.ts';
import type { LineupItem } from '../db/derived_types/Lineup.ts';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { IWorkerPool } from '../interfaces/IWorkerPool.ts';
import { TVGuideService } from '../services/TvGuideService.ts';
import { KEYS } from '../types/inject.ts';
import type { Nullable } from '../types/util.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';

type Request = {
  channelId: string;
};

@injectable()
export class RegenerateChannelLineupCommand {
  @InjectLogger() declare private readonly logger: Logger;

  constructor(
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(KEYS.WorkerPoolFactory)
    private workerPoolProvider: () => IWorkerPool,
    @inject(TVGuideService) private tvGuideService: TVGuideService,
  ) {}

  async execute({ channelId }: Request) {
    const channelAndLineup =
      await this.channelDB.loadChannelAndLineupOrm(channelId);
    if (!channelAndLineup) {
      this.logger.warn('Channel ID %s not found', channelId);
      return;
    }

    const {
      schedule,
      scheduleSeed,
      scheduleDetached,
      items: loadedItems,
    } = channelAndLineup.lineup;
    if (scheduleDetached) {
      // The lineup was edited by hand after this schedule was saved (#76).
      this.logger.debug(
        'Channel %s has a detached schedule; keeping its lineup',
        channelId,
      );
    } else if (schedule) {
      const request = {
        type: 'channel' as const,
        channelId,
        startTime: channelAndLineup.channel.startTime,
        seed: scheduleSeed,
      };

      const { result } =
        schedule.type === 'time'
          ? await this.workerPoolProvider().queueTask({
              type: 'time-slots',
              request: { ...request, schedule },
            })
          : await this.workerPoolProvider().queueTask({
              type: 'schedule-slots',
              request: { ...request, schedule },
            });

      const lineupItems = seq.collect(
        result.lineup,
        channelProgramToLineupItem,
      );

      const saved = await this.channelDB.saveRegeneratedLineup(
        channelId,
        loadedItems,
        { items: lineupItems, scheduleSeed: result.seed },
      );
      if (!saved) {
        this.logger.debug(
          'Lineup for channel %s changed during regeneration; keeping it',
          channelId,
        );
      }
    }

    await this.tvGuideService.updateCachedChannel(channelId, true);
  }
}

function channelProgramToLineupItem(
  p: CondensedChannelProgram,
): Nullable<LineupItem> {
  if (p.type === 'content' && !isNonEmptyString(p.id)) {
    return null;
  }
  return condensedProgramToLineupItem(p);
}
