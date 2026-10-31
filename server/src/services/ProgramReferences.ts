import type { LineupRepository } from '@/db/channel/LineupRepository.js';
import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { sql } from 'drizzle-orm';

export type ProgramReferences = Record<
  'channel' | 'customShow' | 'fillerList',
  Set<string>
>;

// Channel membership comes from the actual lineup, not channel_programs, which
// can lag lineup edits. Missing catalog records must not erase these references.
export async function getProgramReferences(
  db: DrizzleDBAccess,
  lineups: LineupRepository,
  candidates?: ReadonlySet<string>,
): Promise<Map<string, ProgramReferences>> {
  const places = new Map<string, ProgramReferences>();
  if (candidates?.size === 0) {
    return places;
  }
  const add = (
    programId: string,
    kind: keyof ProgramReferences,
    placeId: string,
  ) => {
    if (candidates !== undefined && !candidates.has(programId)) {
      return;
    }
    let entry = places.get(programId);
    if (!entry) {
      entry = {
        channel: new Set(),
        customShow: new Set(),
        fillerList: new Set(),
      };
      places.set(programId, entry);
    }
    entry[kind].add(placeId);
  };

  for (const [channelId, { lineup }] of Object.entries(
    await lineups.loadAllLineups(),
  )) {
    for (const item of lineup.items) {
      if (item.type === 'content') {
        add(item.id, 'channel', channelId);
      }
    }
  }
  const rows = db.all<{
    programId: string;
    kind: keyof ProgramReferences;
    placeId: string;
  }>(sql`
    SELECT program_uuid AS programId, 'channel' AS kind,
           channel_uuid AS placeId FROM channel_fallback
    UNION ALL
    SELECT content_uuid, 'customShow', custom_show_uuid FROM custom_show_content
    UNION ALL
    SELECT program_uuid, 'fillerList', filler_show_uuid FROM filler_show_content`);
  for (const row of rows) {
    add(row.programId, row.kind, row.placeId);
  }
  return places;
}
