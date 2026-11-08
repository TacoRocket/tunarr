import dayjs from 'dayjs';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import type { StreamLineupProgram } from '../db/derived_types/StreamLineup.ts';
import type { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import type { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import { MediaSourceDB } from '../db/mediaSourceDB.ts';
import type { DrizzleDBAccess } from '../db/schema/index.ts';
import { Program } from '../db/schema/Program.ts';
import { supportsNextCreditSqueeze } from '../ffmpeg/CreditSqueeze.ts';
import { EpisodeEndingPreparation } from '../services/EpisodeEndingPreparation.ts';
import { TVGuideService } from '../services/TvGuideService.ts';
import { routesToEtvNext } from '../stream/etv/EtvNextRouting.ts';
import { ProgramStreamDetailsFetcher } from '../stream/ProgramStreamDetailsFetcher.ts';
import { KEYS } from '../types/inject.ts';
import { OpenDateTimeRange } from '../types/OpenDateTimeRange.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

@injectable()
@simpleTaskDef({
  description:
    'Prepare ending intervals for upcoming episodes on moving-ad credit squeeze channels.',
})
export class PrepareEpisodeEndingsTask extends SimpleTask {
  static ID = PrepareEpisodeEndingsTask.name;
  private running = false;

  constructor(
    @inject(KEYS.ChannelDB) private channels: IChannelDB,
    @inject(TVGuideService) private guide: TVGuideService,
    @inject(KEYS.ProgramDB) private programs: IProgramDB,
    @inject(KEYS.DrizzleDB) private db: DrizzleDBAccess,
    @inject(MediaSourceDB) private servers: MediaSourceDB,
    @inject(ProgramStreamDetailsFetcher)
    private streams: ProgramStreamDetailsFetcher,
    @inject(EpisodeEndingPreparation) private endings: EpisodeEndingPreparation,
  ) {
    super();
  }

  protected async runInternal() {
    if (this.running) return;
    this.running = true;
    try {
      const channelIds: string[] = [];
      for (const channel of await this.channels.getAllChannels()) {
        if (
          !channel.creditSqueeze?.enabled ||
          !channel.creditSqueeze.advertisementFillerListIds?.length ||
          !routesToEtvNext(channel.streamMode, channel.useEtvNext ?? false)
        )
          continue;
        const configured = await this.channels.getChannelOrm(channel.uuid);
        if (configured && supportsNextCreditSqueeze(configured))
          channelIds.push(channel.uuid);
      }
      if (!channelIds.length) return;

      const now = dayjs();
      const range = OpenDateTimeRange.create(now, now.add(1, 'hour'));
      if (!range) throw new Error('Invalid ending preparation time window');
      const schedules = await this.guide.getChannelGuides(range, channelIds);
      const upcoming = new Map<string, number>();
      for (const { programs } of schedules) {
        const episodes = new Set<string>();
        for (const item of programs) {
          if (item.type !== 'content' || item.program.type !== 'episode')
            continue;
          upcoming.set(
            item.id,
            Math.min(upcoming.get(item.id) ?? Infinity, item.start),
          );
          episodes.add(item.id);
          if (episodes.size >= 8) break;
        }
      }
      for (const [id] of [...upcoming].sort((a, b) => a[1] - b[1])) {
        try {
          const program = await this.getProgram(id);
          if (program)
            await this.endings.prepare(
              program,
              () => this.getMedia(program),
              () => this.getPeer(program),
            );
        } catch (err) {
          this.logger.warn(err, 'Could not prepare ending for episode %s', id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async getProgram(id: string) {
    const row = await this.programs.getLineupProgramById(id);
    if (!row?.mediaSourceId || row.type !== 'episode') return;
    return { ...row, mediaSourceId: row.mediaSourceId };
  }

  private async getMedia(program: StreamLineupProgram) {
    const server = await this.servers.getById(program.mediaSourceId);
    if (!server) return;
    const result = await this.streams.getStream({
      lineupItem: program,
      server,
    });
    return result.getOrThrow();
  }

  private async getPeer(program: StreamLineupProgram) {
    if (!program.tvShowUuid || !program.seasonUuid || program.episode === null)
      return;
    const [peer] = await this.db
      .select({ uuid: Program.uuid })
      .from(Program)
      .where(
        and(
          eq(Program.type, 'episode'),
          eq(Program.state, 'ok'),
          eq(Program.mediaSourceId, program.mediaSourceId),
          eq(Program.tvShowUuid, program.tvShowUuid),
          eq(Program.seasonUuid, program.seasonUuid),
          ne(Program.episode, program.episode),
        ),
      )
      .orderBy(
        sql`abs(${Program.episode} - ${program.episode})`,
        asc(Program.episode),
        asc(Program.uuid),
      )
      .limit(1);
    const sibling = peer && (await this.getProgram(peer.uuid));
    return sibling && this.getMedia(sibling);
  }
}
