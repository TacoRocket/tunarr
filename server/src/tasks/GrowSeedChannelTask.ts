import { inject, injectable } from 'inversify';
import { z } from 'zod/v4';
import type { LineupRepository } from '../db/channel/LineupRepository.ts';
import { getSeedGrowthWindow } from '../db/channel/seedGrowth.ts';
import { condensedProgramToLineupItem } from '../db/channel/lineupItemConversion.ts';
import { isContentItem } from '../db/derived_types/Lineup.ts';
import { ProgramPlayHistoryDB } from '../db/ProgramPlayHistoryDB.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { GlobalScheduler } from '../services/Scheduler.ts';
import { SeedChannelService } from '../services/scheduling/SeedChannelService.ts';
import { KEYS } from '../types/inject.ts';
import { MutexMap } from '../util/mutexMap.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';
import { UpdateXmlTvTask } from './UpdateXmlTvTask.ts';

const GrowSeedChannelRequest = z.object({
  channelId: z.uuid(),
  historyId: z.uuid(),
});

@injectable()
@taskDef({
  description: 'Extends a seed channel after a recorded play',
  schema: GrowSeedChannelRequest,
  hidden: true,
})
export class GrowSeedChannelTask extends Task2<typeof GrowSeedChannelRequest> {
  readonly ID = GrowSeedChannelTask.name;
  readonly schema = GrowSeedChannelRequest;
  private static locks = new MutexMap();

  constructor(
    @inject(KEYS.LineupRepository) private lineups: LineupRepository,
    @inject(ProgramPlayHistoryDB) private history: ProgramPlayHistoryDB,
    @inject(KEYS.ProgramDB) private programs: ProgramDB,
    @inject(SeedChannelService) private generator: SeedChannelService,
  ) {
    super();
  }

  protected async runInternal(request: z.infer<typeof GrowSeedChannelRequest>) {
    await GrowSeedChannelTask.locks.runWithLockId(
      request.channelId,
      async () => {
        const play = await this.history.getById(request.historyId);
        if (
          !play ||
          play.channelUuid !== request.channelId ||
          play.fillerListId
        )
          return;
        const original = await this.lineups.loadChannelAndLineup(
          request.channelId,
        );
        if (!original?.lineup.seedGrowth) return;
        const { channel } = original;
        // The repository caches mutable lineup objects. Keep a real snapshot
        // across metadata queries so the publish guard can detect intervening edits.
        const lineup = structuredClone(original.lineup);
        const config = lineup.seedGrowth;
        if (!config || lineup.seedGrowthLastPlayId === play.uuid) return;
        const window = getSeedGrowthWindow(
          lineup.items,
          channel.startTime,
          Date.now(),
        );
        if (!window || window.remainingMs >= config.targetHours * 3_600_000)
          return;

        const [watched] = await this.programs.getProgramsByIds([
          play.programUuid,
        ]);
        if (!watched)
          throw new Error(
            'The watched program disappeared before channel growth',
          );
        const queued = lineup.items
          .slice(window.currentIndex)
          .filter(isContentItem);
        const generated = await this.generator.generate(
          {
            channelId: channel.uuid,
            seedProgramIds: config.seedProgramIds,
            familiarity: config.familiarity,
            hours: 1,
          },
          {
            trigger: {
              historyId: play.uuid,
              programId: play.programUuid,
              title: watched.title,
              playedAt: play.playedAt.getTime(),
            },
            previousProgramId: queued.at(-1)?.id,
            queuedProgramIds: queued.map((item) => item.id),
          },
        );
        const program = generated.lineup[0];
        if (!program) throw new Error('Channel growth returned no program');
        const added = condensedProgramToLineupItem(program);
        if (!isContentItem(added))
          throw new Error('Channel growth returned non-content');
        if (
          await this.lineups.applySeedGrowth(
            channel.uuid,
            lineup,
            channel.startTime,
            added,
            play.uuid,
          )
        ) {
          await GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID).runNow(
            false,
            {
              channelId: channel.uuid,
            },
          );
          this.logger.info(
            'Added %s to channel %s after play %s',
            added.id,
            channel.uuid,
            play.uuid,
          );
        }
      },
    );
  }
}
