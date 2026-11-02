import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Program } from '../../db/schema/Program.ts';
import { ProgramPlayHistory } from '../../db/schema/ProgramPlayHistory.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';

export const BalancedHistoryStartLimit = 50;

/** Select a bounded, chronological window after resolving available sources. */
export function getBalancedHistorySources(
  db: DrizzleDBAccess,
  channelId: string,
  availableSourceIds: readonly string[],
): string[] {
  if (availableSourceIds.length === 0) return [];
  const sourceId = sql<string>`coalesce(${Program.tvShowUuid}, ${Program.uuid})`;
  return db
    .select({ sourceId })
    .from(ProgramPlayHistory)
    .innerJoin(Program, eq(Program.uuid, ProgramPlayHistory.programUuid))
    .where(
      and(
        eq(ProgramPlayHistory.channelUuid, channelId),
        isNull(ProgramPlayHistory.fillerListId),
        // One JSON parameter avoids SQLite's bind limit on large libraries.
        sql`${sourceId} in (select value from json_each(${JSON.stringify(availableSourceIds)}))`,
      ),
    )
    .orderBy(desc(ProgramPlayHistory.playedAt), desc(ProgramPlayHistory.uuid))
    .limit(BalancedHistoryStartLimit)
    .all()
    .reverse()
    .map((play) => play.sourceId);
}
