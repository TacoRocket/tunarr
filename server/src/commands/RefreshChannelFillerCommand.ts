import type {
  RefreshFillerRequest,
  RefreshFillerResult,
} from '@tunarr/types/api';
import { inject, injectable } from 'inversify';
import type { LineupRepository } from '../db/channel/LineupRepository.ts';
import { condensedProgramToLineupItem } from '../db/channel/lineupItemConversion.ts';
import { isContentItem, type ContentItem } from '../db/derived_types/Lineup.ts';
import { BlockGenerationService } from '../services/scheduling/BlockGenerationService.ts';
import { ScheduleValidationError } from '../types/errors.ts';
import { KEYS } from '../types/inject.ts';

@injectable()
export class RefreshChannelFillerCommand {
  constructor(
    @inject(KEYS.LineupRepository) private lineups: LineupRepository,
    @inject(BlockGenerationService) private blocks: BlockGenerationService,
  ) {}

  async execute(
    channelId: string,
    request: RefreshFillerRequest,
  ): Promise<RefreshFillerResult> {
    const original = await this.lineups.loadChannelAndLineup(channelId);
    if (!original)
      throw new ScheduleValidationError(`Channel ${channelId} does not exist`);
    if (
      original.lineup.onDemandConfig ||
      original.lineup.schedule?.type === 'time'
    ) {
      throw new ScheduleValidationError(
        'Filler refresh requires a looping channel without a time-slot schedule',
      );
    }

    const pools = new Set(request.fillerListIds);
    const positions = original.lineup.items.flatMap((item, index) =>
      isContentItem(item) &&
      item.fillerType === 'post' &&
      item.fillerListId &&
      pools.has(item.fillerListId)
        ? [{ index, poolId: item.fillerListId }]
        : [],
    );
    for (const poolId of pools) {
      if (!positions.some((position) => position.poolId === poolId)) {
        throw new ScheduleValidationError(
          `Pool ${poolId} has no saved after-show positions on this channel`,
        );
      }
    }

    const generated = await this.blocks.generate({
      entries: positions.map(({ poolId }) => ({
        type: 'break',
        positions: [{ fillerListIds: [poolId] }],
      })),
      seed: request.seed,
    });
    const replacements = new Map<number, ContentItem>();
    for (const [offset, position] of positions.entries()) {
      const selected = generated.lineup[offset];
      if (
        !selected ||
        selected.type !== 'filler' ||
        selected.fillerListId !== position.poolId
      ) {
        throw new Error(
          `Block generation did not return filler for position ${position.index}`,
        );
      }
      const item = condensedProgramToLineupItem(selected);
      if (!isContentItem(item))
        throw new Error('Generated filler is not content');
      replacements.set(position.index, item);
    }

    return {
      ...(await this.lineups.applyFillerRefresh(
        channelId,
        original.lineup,
        original.channel.startTime,
        replacements,
      )),
      seed: generated.seed,
    };
  }
}
