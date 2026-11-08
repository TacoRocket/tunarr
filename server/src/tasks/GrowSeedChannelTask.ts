import { inject, injectable } from 'inversify';
import { z } from 'zod/v4';
import type { LineupRepository } from '../db/channel/LineupRepository.ts';
import { getSeedGrowthWindow } from '../db/channel/seedGrowth.ts';
import { condensedProgramToLineupItem } from '../db/channel/lineupItemConversion.ts';
import { isContentItem } from '../db/derived_types/Lineup.ts';
import { ProgramPlayHistoryDB } from '../db/ProgramPlayHistoryDB.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { GlobalScheduler } from '../services/Scheduler.ts';
import { rollingSeedTargetMs } from '../services/scheduling/RollingSeedChannel.ts';
import {
  isSimilarityFallbackWarning,
  SeedChannelService,
} from '../services/scheduling/SeedChannelService.ts';
import { KEYS } from '../types/inject.ts';
import { MutexMap } from '../util/mutexMap.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';
import { UpdateXmlTvTask } from './UpdateXmlTvTask.ts';

const GrowSeedChannelRequest = z.object({
  channelId: z.uuid(),
  historyId: z.uuid().optional(),
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
        const play = request.historyId
          ? await this.history.getById(request.historyId)
          : undefined;
        if (
          request.historyId &&
          (!play || play.channelUuid !== request.channelId || play.fillerListId)
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
        if (
          !config ||
          (!config.rolling && !play) ||
          (play && lineup.seedGrowthLastPlayId === play.uuid)
        )
          return;
        const window = getSeedGrowthWindow(
          lineup.items,
          channel.startTime,
          Date.now(),
        );
        if (!window) return;
        const limit = config.rolling?.maximumHours ?? config.targetHours;
        if (window.remainingMs >= limit * 3_600_000) return;
        const tail = lineup.items.slice(window.currentIndex);
        const queued = tail.filter(isContentItem);
        const loaded = await this.programs.getProgramsByIds([
          ...new Set([
            ...(config.rolling ? queued.map((item) => item.id) : []),
            ...(play ? [play.programUuid] : []),
          ]),
        ]);
        const byId = new Map(loaded.map((program) => [program.uuid, program]));
        const watched = play ? byId.get(play.programUuid) : undefined;
        if (play && !watched)
          throw new Error(
            'The watched program disappeared before channel growth',
          );
        let movieMs = 0;
        if (config.rolling) {
          for (const [index, item] of tail.entries()) {
            if (!isContentItem(item)) continue;
            const program = byId.get(item.id);
            if (!program)
              throw new Error(
                'A queued program disappeared before rolling channel growth',
              );
            if (program.type === 'movie')
              movieMs +=
                item.durationMs - (index === 0 ? window.elapsedInItem : 0);
          }
          if (
            window.remainingMs >= rollingSeedTargetMs(config.rolling, movieMs)
          )
            return;
        }
        const generated = await this.generator.generate(
          {
            channelId: channel.uuid,
            seedProgramIds: config.seedProgramIds,
            familiarity: config.familiarity,
            recommendationMode: config.recommendationMode,
            discovery: config.discovery,
            hours: config.rolling?.minimumHours ?? 1,
            rolling: config.rolling,
          },
          {
            trigger:
              play && watched
                ? {
                    historyId: play.uuid,
                    programId: play.programUuid,
                    title: watched.title,
                    playedAt: play.playedAt.getTime(),
                  }
                : undefined,
            rollingWindow: config.rolling
              ? { remainingMs: window.remainingMs, movieMs }
              : undefined,
            previousProgramId: queued.at(-1)?.id,
            queuedProgramIds: queued.map((item) => item.id),
          },
        );
        const items = generated.lineup.map(condensedProgramToLineupItem);
        const added = items.filter(isContentItem);
        if (added.length === 0 || added.length !== items.length)
          throw new Error('Channel growth returned no playable content');
        for (const warning of generated.warnings) {
          if (isSimilarityFallbackWarning(warning)) this.logger.debug(warning);
          else this.logger.warn(warning);
        }
        if (
          await this.lineups.applySeedGrowth(
            channel.uuid,
            lineup,
            channel.startTime,
            added,
            play?.uuid,
          )
        ) {
          await GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID).runNow(
            false,
            {
              channelId: channel.uuid,
            },
          );
          this.logger.info(
            'Added %d programs to channel %s after %s',
            added.length,
            channel.uuid,
            play?.uuid ?? 'scheduled refill',
          );
        }
      },
    );
  }
}
