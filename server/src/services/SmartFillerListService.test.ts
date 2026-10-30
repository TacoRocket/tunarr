import { search as searchUtil } from '@tunarr/shared/util';
import type { CustomProgram } from '@tunarr/types';
import type Database from 'better-sqlite3';
import tmp from 'tmp-promise';
import { v4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bootstrapTunarr } from '../bootstrap.ts';
import { DBAccess } from '../db/DBAccess.ts';
import { FillerDB } from '../db/FillerListDB.ts';
import type { ProgramDB } from '../db/ProgramDB.ts';
import { SmartCollectionsDB } from '../db/SmartCollectionsDB.ts';
import { setGlobalOptions } from '../globals.ts';
import { copyPreMigratedDb } from '../testing/testDbFactory.ts';
import { SmartFillerSyncError } from '../types/errors.ts';
import type { MeilisearchService } from './MeilisearchService.ts';
import { SmartFillerListService } from './SmartFillerListService.ts';

type SearchDoc = { id: string; type: string };

type Harness = {
  sqlite: Database.Database;
  fillerDB: FillerDB;
  service: SmartFillerListService;
  // What each smart collection's search returns. A missing entry throws, the
  // way an unreachable or rebuilding search index does.
  results: Map<string, SearchDoc[]>;
  // Milliseconds a collection's search takes, for ordering tests.
  delays: Map<string, number>;
  // Whether the search index reports unfinished indexing tasks.
  indexing: { pending: boolean };
  // The same service over the real smart collection lookup, whose search
  // returns nothing; for checks that happen before any search runs.
  strictService: SmartFillerListService;
  addClip(opts?: { state?: 'ok' | 'missing'; duration?: number }): string;
  addCollection(query?: string | null): string;
  contentOf(fillerId: string): string[];
  linkOf(fillerId: string): string | null;
};

// Bootstrapping opens the database once per test file, so the tests share it
// and keep apart by using fresh IDs.
async function createHarness(dir: string): Promise<Harness> {
  await copyPreMigratedDb(dir);
  setGlobalOptions({ database: dir, log_level: 'error', verbose: 0 });
  await bootstrapTunarr();
  const dbPath = `${dir}/db.db`;
  const conn = DBAccess.instance.getConnection(dbPath);
  const db = DBAccess.instance.db;
  const drizzle = DBAccess.instance.drizzle;
  if (!conn || !db || !drizzle) {
    throw new Error('Expected DB handles for the test');
  }
  const sqlite = conn.sqlite;
  const fillerDB = new FillerDB(db, drizzle);
  const results = new Map<string, SearchDoc[]>();
  const programs = new Map<
    string,
    { uuid: string; state: string; duration: number }
  >();

  const delays = new Map<string, number>();
  const indexing = { pending: false };
  const smartCollections = {
    materializeSmartCollection: async (id: string) => {
      // Read the result when the search starts, as a real search would.
      const docs = results.get(id);
      await new Promise((resolve) => setTimeout(resolve, delays.get(id) ?? 0));
      if (!docs) {
        throw new Error('search unavailable');
      }
      return docs;
    },
  } as unknown as SmartCollectionsDB;
  const programDB = {
    getProgramsByIds: (ids: readonly string[]) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const program = programs.get(id);
          return program ? [program] : [];
        }),
      ),
  } as unknown as ProgramDB;
  const search = {
    waitForPendingIndexTasks: () => Promise.resolve(),
    hasPendingIndexTasks: () => Promise.resolve(indexing.pending),
    search: () => Promise.resolve({ results: [] }),
  } as unknown as MeilisearchService;

  return {
    sqlite,
    fillerDB,
    service: new SmartFillerListService(
      fillerDB,
      smartCollections,
      programDB,
      search,
    ),
    results,
    delays,
    indexing,
    strictService: new SmartFillerListService(
      fillerDB,
      new SmartCollectionsDB(drizzle, new searchUtil.SearchParser(), search),
      programDB,
      search,
    ),
    addClip({ state = 'ok', duration = 30_000 } = {}) {
      const uuid = v4();
      sqlite
        .prepare(
          `INSERT INTO program (uuid, duration, external_key, external_source_id, source_type, title, type, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uuid,
          duration,
          uuid,
          'local',
          'local',
          uuid,
          'other_video',
          state,
        );
      programs.set(uuid, { uuid, state, duration });
      return uuid;
    },
    addCollection(query: string | null = 'tags = "/commercials/Nintendo"') {
      const uuid = v4();
      sqlite
        .prepare(
          'INSERT INTO smart_collection (uuid, name, query) VALUES (?, ?, ?)',
        )
        .run(uuid, uuid, query);
      return uuid;
    },
    contentOf(fillerId) {
      return (
        sqlite
          .prepare(
            'SELECT program_uuid FROM filler_show_content WHERE filler_show_uuid = ? ORDER BY "index"',
          )
          .all(fillerId) as { program_uuid: string }[]
      ).map((row) => row.program_uuid);
    },
    linkOf(fillerId) {
      return (
        sqlite
          .prepare('SELECT smart_collection_id FROM filler_show WHERE uuid = ?')
          .get(fillerId) as { smart_collection_id: string | null }
      ).smart_collection_id;
    },
  };
}

let dir: tmp.DirectoryResult;
let harness: Harness;

beforeAll(async () => {
  dir = await tmp.dir({ unsafeCleanup: true });
  harness = await createHarness(dir.path);
});

afterAll(async () => {
  await DBAccess.instance.closeConnection(`${dir.path}/db.db`);
  await dir.cleanup();
});

const withHarness = (run: (h: Harness) => Promise<void>) => run(harness);

const clip = (id: string): SearchDoc => ({ id, type: 'other_video' });

// A program as the list editor submits it. Only its id is stored.
const handBuilt = (id: string): CustomProgram => ({
  type: 'custom',
  id,
  customShowId: v4(),
  index: 0,
  persisted: true,
  duration: 30_000,
});

describe('SmartFillerListService', () => {
  test('a linked list is created with the playable clips the collection matches', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const missing = h.addClip({ state: 'missing' });
      const noDuration = h.addClip({ duration: 0 });
      const collection = h.addCollection();
      h.results.set(collection, [
        clip(b),
        { id: v4(), type: 'show' },
        clip(missing),
        clip(a),
        clip(noDuration),
        clip(b),
      ]);

      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      expect(h.linkOf(id)).toBe(collection);
      expect(h.contentOf(id)).toEqual([b, a]);
    }));

  test('a collection with no playable clips creates nothing', () =>
    withHarness(async (h) => {
      const collection = h.addCollection();
      h.results.set(collection, [clip(h.addClip({ state: 'missing' }))]);

      await expect(
        h.service.create({ name: 'Empty', smartCollectionId: collection }),
      ).rejects.toThrow(SmartFillerSyncError);
      expect(
        h.sqlite
          .prepare('SELECT COUNT(*) AS n FROM filler_show WHERE name = ?')
          .get('Empty'),
      ).toEqual({ n: 0 });
    }));

  test('sync replaces the content with the current results', () =>
    withHarness(async (h) => {
      const [a, b, c] = [h.addClip(), h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a), clip(b)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      h.results.set(collection, [clip(c), clip(a)]);
      const result = await h.service.sync(id);

      expect(h.contentOf(id)).toEqual([c, a]);
      expect(result).toEqual({
        fillerListId: id,
        smartCollectionId: collection,
        programCount: 2,
        skippedGroupings: 0,
        skippedUnplayable: 0,
      });
    }));

  test('a sync that finds nothing, or cannot search, keeps the content', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a), clip(b)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      h.results.set(collection, []);
      await expect(h.service.sync(id)).rejects.toThrow(SmartFillerSyncError);
      expect(h.contentOf(id)).toEqual([a, b]);

      h.results.delete(collection);
      await expect(h.service.sync(id)).rejects.toThrow(SmartFillerSyncError);
      expect(h.contentOf(id)).toEqual([a, b]);
    }));

  test('programs cannot be edited by hand while the list is linked', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });
      const program = handBuilt(b);

      await expect(
        h.service.update(id, { programs: [program] }),
      ).rejects.toThrow(SmartFillerSyncError);
      expect(h.contentOf(id)).toEqual([a]);

      // Unlinking keeps the synced content as an ordinary list.
      await h.service.update(id, { smartCollectionId: null });
      expect(h.linkOf(id)).toBeNull();
      expect(h.contentOf(id)).toEqual([a]);

      await h.service.update(id, { programs: [program] });
      expect(h.contentOf(id)).toEqual([b]);
    }));

  test('linking an existing hand-built list replaces its content', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const id = await h.fillerDB.createFiller({
        name: 'Hand built',
        programs: [handBuilt(a)],
      });
      const collection = h.addCollection();
      h.results.set(collection, [clip(b)]);

      await h.service.update(id, { smartCollectionId: collection });

      expect(h.linkOf(id)).toBe(collection);
      expect(h.contentOf(id)).toEqual([b]);
    }));

  test('deleting the smart collection unlinks the list and keeps its content', () =>
    withHarness(async (h) => {
      const a = h.addClip();
      const collection = h.addCollection();
      h.results.set(collection, [clip(a)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      h.sqlite
        .prepare('DELETE FROM smart_collection WHERE uuid = ?')
        .run(collection);

      expect(h.linkOf(id)).toBeNull();
      expect(h.contentOf(id)).toEqual([a]);
    }));

  test('a list relinked during a sync is not overwritten', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const [first, second] = [h.addCollection(), h.addCollection()];
      h.results.set(first, [clip(a)]);
      h.results.set(second, [clip(b)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: second,
      });

      expect(h.fillerDB.replaceSyncedContent(id, first, [a])).toBe(false);
      expect(h.contentOf(id)).toEqual([b]);
    }));

  test('syncing every linked list carries on past one that fails', () =>
    withHarness(async (h) => {
      const [a, b, c] = [h.addClip(), h.addClip(), h.addClip()];
      const [broken, working] = [h.addCollection(), h.addCollection()];
      h.results.set(broken, [clip(a)]);
      h.results.set(working, [clip(b)]);
      const brokenList = await h.service.create({
        name: 'Broken',
        smartCollectionId: broken,
      });
      const workingList = await h.service.create({
        name: 'Working',
        smartCollectionId: working,
      });

      h.results.delete(broken);
      h.results.set(working, [clip(c)]);
      await h.service.syncAll();

      expect(h.contentOf(brokenList)).toEqual([a]);
      expect(h.contentOf(workingList)).toEqual([c]);
    }));

  test('a linked list can be renamed by the list editor', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a), clip(b)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      // The editor sends back the programs it loaded, in any order.
      const saved = await h.service.update(id, {
        name: 'Retro Gaming',
        programs: [handBuilt(b), handBuilt(a)],
      });

      expect(saved?.name).toBe('Retro Gaming');
      expect(h.linkOf(id)).toBe(collection);
      expect(h.contentOf(id)).toEqual([a, b]);
    }));

  test('nothing syncs while the search index is still updating', () =>
    withHarness(async (h) => {
      const [a, b] = [h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      h.results.set(collection, [clip(b)]);
      h.indexing.pending = true;
      try {
        await expect(h.service.sync(id)).rejects.toThrow(SmartFillerSyncError);
        await expect(
          h.service.create({ name: 'Partial', smartCollectionId: collection }),
        ).rejects.toThrow(SmartFillerSyncError);
      } finally {
        h.indexing.pending = false;
      }
      expect(h.contentOf(id)).toEqual([a]);
    }));

  test('a slow sync cannot overwrite a newer one', () =>
    withHarness(async (h) => {
      const [a, b, c] = [h.addClip(), h.addClip(), h.addClip()];
      const collection = h.addCollection();
      h.results.set(collection, [clip(a)]);
      const id = await h.service.create({
        name: 'Nintendo',
        smartCollectionId: collection,
      });

      // The first sync reads an old result and is slow to finish; the second
      // starts later and reads the new one.
      h.results.set(collection, [clip(b)]);
      h.delays.set(collection, 50);
      const slow = h.service.sync(id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      h.results.set(collection, [clip(c)]);
      h.delays.delete(collection);
      const fast = h.service.sync(id);
      await Promise.all([slow, fast]);

      expect(h.contentOf(id)).toEqual([c]);
    }));

  test('a collection that would match the whole library is refused', () =>
    withHarness(async (h) => {
      const everything = h.addCollection(null);

      await expect(
        h.strictService.create({
          name: 'Everything',
          smartCollectionId: everything,
        }),
      ).rejects.toThrow(/matches the whole library/);
    }));

  test('a filler list is never created empty', () =>
    withHarness(async (h) => {
      await expect(
        h.fillerDB.createFiller({ name: 'Empty internal', programs: [] }),
      ).rejects.toThrow();
      expect(
        h.sqlite
          .prepare('SELECT COUNT(*) AS n FROM filler_show WHERE name = ?')
          .get('Empty internal'),
      ).toEqual({ n: 0 });
    }));
});
