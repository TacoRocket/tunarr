import { inject, injectable } from 'inversify';
import { chunk, uniq } from 'lodash-es';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { KEYS } from '../../types/inject.ts';
import { ScheduleValidationError } from '../../types/errors.ts';

// Channel-specific playback endpoints. Catalog and filler durations stay whole.
@injectable()
export class ChannelProgramDurationService {
  constructor(@inject(KEYS.DrizzleDB) private db: DrizzleDBAccess) {}

  async finalCreditEnds(
    channelId: string | number | undefined,
    programIds: string[],
  ) {
    const ends = new Map<string, number>();
    if (channelId === undefined) return ends;
    const channel = await this.db.query.channels.findFirst({
      where: (fields, { eq }) =>
        typeof channelId === 'number'
          ? eq(fields.number, channelId)
          : eq(fields.uuid, channelId),
      columns: { advanceAtFinalCredits: true },
    });
    if (!channel)
      throw new ScheduleValidationError(`Channel ${channelId} does not exist`);
    if (!channel.advanceAtFinalCredits) return ends;

    for (const ids of chunk(uniq(programIds), 200)) {
      const programs = await this.db.query.program.findMany({
        where: (fields, { inArray }) => inArray(fields.uuid, ids),
        columns: { uuid: true, duration: true },
        with: { versions: { with: { chapters: true } } },
      });
      for (const program of programs) {
        // Playback also takes the first stored version (ProgramStreamDetailsFetcher).
        const version = program.versions[0];
        const finals =
          version?.chapters.filter(
            (chapter) =>
              chapter.chapterType === 'outro' && chapter.isFinal === true,
          ) ?? [];
        const marker = finals.length === 1 ? finals[0] : undefined;
        if (
          version &&
          marker &&
          Number.isFinite(marker.startTime) &&
          Number.isFinite(marker.endTime) &&
          marker.startTime > 0 &&
          marker.startTime < marker.endTime &&
          marker.endTime <= program.duration &&
          marker.endTime <= version.duration
        ) {
          ends.set(program.uuid, marker.startTime);
        }
      }
    }
    return ends;
  }
}
