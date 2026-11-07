import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, test } from 'vitest';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { getBalancedHistorySources } from './BalancedSeedChannelHistory.ts';

test('bounds reconstruction to the last 50 available channel starts before reading rows', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE program (uuid TEXT PRIMARY KEY, tv_show_uuid TEXT);
      CREATE TABLE program_play_history (
        uuid TEXT PRIMARY KEY, program_uuid TEXT, channel_uuid TEXT,
        filler_list_id TEXT, played_at INTEGER
      );
    `);
    const insertProgram = sqlite.prepare('INSERT INTO program VALUES (?, ?)');
    const insertPlay = sqlite.prepare(
      'INSERT INTO program_play_history VALUES (?, ?, ?, ?, ?)',
    );
    const sources: string[] = [];
    for (let index = 0; index < 200; index++) {
      const id = `source-${String(index).padStart(3, '0')}`;
      sources.push(id);
      insertProgram.run(`episode-${index}`, id);
      insertPlay.run(id, `episode-${index}`, 'channel', null, index);
    }
    insertProgram.run('unavailable', null);
    insertPlay.run('unavailable', 'unavailable', 'channel', null, 1000);
    insertPlay.run('filler', 'episode-0', 'channel', 'filler-list', 1001);
    insertPlay.run('other-channel', 'episode-0', 'other-channel', null, 1002);
    // Equal timestamps retain the same UUID tie order as full reconstruction.
    insertPlay.run('z-repeat', 'episode-199', 'channel', null, 199);
    const queries: { query: string; params: unknown[] }[] = [];
    const db = drizzle(sqlite, {
      casing: 'snake_case',
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    }) as unknown as DrizzleDBAccess;
    expect(getBalancedHistorySources(db, 'channel', sources)).toEqual([
      ...sources.slice(151),
      'source-199',
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.query).toContain('limit ?');
    expect(queries[0]?.params.at(-1)).toBe(50);
  } finally {
    sqlite.close();
  }
});
