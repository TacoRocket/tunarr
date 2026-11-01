# Local scan: per-item fingerprint (#2208)

> **Status (11/01/2026):** Planned; design reviewed 11/01/2026 (see "Decisions"). Prerequisite PR first, then branch `feat/local-scan-item-fingerprint`. Tracker #2209; follow-up #2407.

## Goal

- Skip ffprobe, metadata reads, and every DB write for a local item whose files are unchanged.
- "Files" means the whole logical item: media file, NFO, subtitle sidecars, per-item artwork.
- v1 is all-or-nothing. Any changed part reprocesses the item exactly as today.
- Store the parts separately so #2407 can narrow the work per part without a migration.
- No drift between the DB and the search index. Skipping must never leave a search document stale.

## Current behavior

- Folder gate: `LocalFolderCanonicalizer` hashes folder mtime plus each entry's name and mtime. An unchanged folder is skipped.
- A changed folder reprocesses every item in it: one ffprobe and ~10 statements per item.
- `force` bypasses the folder gate and reprocesses the whole library.
- No per-item "last seen" record exists. `program.updated_at` is rewritten on every upsert.
- Episode and track search documents copy parent fields (show, album, artist) into `parent`/`grandparent`. Only re-indexing the child refreshes them.
- Nothing rebuilds the search index from the DB. Only scans repopulate it.

The folder gate stays. The item gate runs inside a folder that already failed the folder gate, or during a `force` scan.

## Prerequisite PR: search consistency

Lands before the item gate. It fixes drift that exists today, and the item gate depends on it.

### Parent push-down

- After a grouping upsert, build its denormalized block from the in-memory grouping the scanner already holds.
- Query the grouping's child uuids (one query, e.g. `program.tv_show_uuid = ?`).
- Send `{ id, parent | grandparent }` per child through `MeilisearchService.updatePrograms` (partial update; Meilisearch merges the fields).
- Run after every grouping upsert, with no diff check. Grouping upserts already run only when their folder changes.

| grouping | children | field                                                    |
| -------- | -------- | -------------------------------------------------------- |
| show     | episodes | `grandparent`                                            |
| album    | tracks   | `parent`                                                 |
| artist   | tracks   | `grandparent`                                            |
| artist   | albums   | `parent`, if album documents copy artist fields (verify) |

- Fixes today's stale show fields on episodes in season folders. A `tvshow.nfo` edit fails the show folder gate, but each season folder passes its own gate, so those episodes are never re-indexed.
- Scope: local scanners. Whether remote scanners need the same push-down is an open check.

### Forced rescan after a fresh index

- When `MeilisearchService.doSync` creates the `programs` index instead of finding it, persist a "search index rebuilt" flag.
- The next scan of every library (local and remote) runs with `force`. Clear the flag per library once its forced scan completes.
- The flag must survive a restart, so it lives in the DB or settings, not in memory.
- Covers a deleted `data.ms`, a restore without it, or a failed Meilisearch upgrade.

## Design

### Logical item membership

An item's files are all in the media file's own directory.

| part        | files                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `video`     | the media file                                                                                        |
| `metadata`  | `<stem>.nfo`; plus `movie.nfo` for movies                                                             |
| `subtitles` | stem-prefixed files with a subtitle extension (`.srt`, `.ass`, `.ssa`, `.vtt`)                        |
| `artwork`   | stem-prefixed image files; plus `poster`, `fanart`, `banner`, `landscape`, `folder` images for movies |
| `other`     | any other stem-prefixed file                                                                          |

- "Stem-prefixed" uses the same rule as `LocalSubtitlesService.findExternalSubtitles`: `name.startsWith(stem)`, no separator. The fingerprint must cover at least everything discovery can pick up.
- The prefix rule over-includes (`Ep1` matches `Ep10.mkv`). That only causes extra reprocessing, which is safe.
- Shared names (movie NFO and artwork) come from the scanner, so each scanner declares its own extras.
- `other` exists so an unknown sidecar still invalidates the item. #2407 treats an `other` change as a full reprocess.
- Verified 11/01/2026: every NFO, artwork, and subtitle lookup in the five local scanners reads the media file's own directory with stem-prefixed names or the movie shared names above.
- No media source or library setting changes scanner output, so the fingerprint covers files only.

### Fingerprint value

- Each part is a SHA-1 over its files sorted by name, hashing `name`, `mtimeMs`, and `size` for each file.
- A part with no files hashes to a fixed empty value, so adding the first sidecar changes it.
- The stored value is JSON: `{ "v": 1, "video": "…", "metadata": "…", "subtitles": "…", "artwork": "…", "other": "…" }`.
- Serialize with a fixed key order and compare strings.
- `v` is the scanner version. Bump it when membership rules **or** per-item scanner output change (NFO parsing, canonicalization, duration rounding). A bump invalidates every stored fingerprint.
- The `v` constant lives in the fingerprint module, with a comment saying when to bump it.

### Storage

New nullable column `program.local_fingerprint` (text, JSON).

| option               | lookup                                                                                                                    | verdict    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `program`            | `(source_type, media_source_id, external_key)` is already unique-indexed; `external_key` is the file path for local items | **chosen** |
| `program_media_file` | no index on `path`; `local_media_folder_id` is not set by the other-video scanner                                         | rejected   |

- Add `program.localFingerprint` to `AllProgramFields`, so `ProgramUpsertSetClause` writes it on upsert.
- Remote sources never set it, so they write `NULL`. That's harmless.
- The fingerprint is written by the same upsert as the program, so the two can't drift apart.
- Migration via `pnpm drizzle-kit generate`.

### Gate

Per folder (or per directory, for recursive season and album walks):

1. List and stat the directory once. Reuse the stats for every item in it.
2. Batch-read stored fingerprints with `external_key IN (…)` for the folder's media files, chunked. Return `uuid`, `externalKey`, `localFingerprint`, `state`.
3. For each item, compute the fingerprint **before** any other work.
4. Skip the item when all of these hold:
   - `context.force` is false
   - a stored row exists with `state = 'ok'`
   - the stored JSON equals the computed JSON, including `v`
5. Otherwise process as today and set `dao.program.localFingerprint` to the value from step 3.
6. If search indexing throws after the upsert, clear the fingerprint (`local_fingerprint = NULL`) for that item, or for every track in a failed music batch. The next scan then reprocesses it.

The gate is a protected helper on `FileSystemScanner`, the shared base of all five local scanners. It returns the fingerprint and skip decision per item.

Notes:

- Computing before processing is conservative. A file that changes mid-scan doesn't match the stored value next time, so it gets reprocessed.
- `state = 'ok'` matters. A file that goes missing and comes back with the same mtime and size must be reprocessed, or it stays `missing` forever.
- A stat failure counts as changed.
- Skipped items keep their artwork rows, subtitle rows, and own search fields untouched. Their parent fields still update through the push-down.

### Per-scanner wiring

| scanner     | per-item path       | extra notes                                                                                                  |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Other video | `scanVideoFile`     | none                                                                                                         |
| Music video | `scanVideoFile`     | none                                                                                                         |
| Movie       | `handleVideoFile`   | movie shared names; drop the `findExistingLocalProgram` read for skipped items                               |
| TV          | `handleEpisodeFile` | season walk is recursive, so group stats by `parentPath`; a multi-episode file shares one `external_key` row |
| Music       | `scanTrack`         | see below                                                                                                    |

**Music needs partial skipping.** `scanAlbum` derives album genres and release date from every track's embedded tags (`rawMetadata`) on each album scan. A fully skipped track would drop its genres from the album. So for an unchanged track:

- still run `parseFile` (tag read, no subprocess) and return its `rawMetadata` for the album derivation
- skip ffprobe, the track upsert, and its search indexing
- `scanTrack` runs ffprobe (`getMediaItem`) before `parseFile` today, so it must split

This keeps album output identical and still removes the expensive part. Reading genres and release dates from the stored rows was rejected, because it adds a second derivation path that must stay in sync with the parsed one.

## Unchanged behavior

- Folder gate and folder `canonical_id` updates.
- The missing-program sweep (`getProgramInfoForMediaSourceLibrary` + `updateProgramsState`). It checks file existence, not scan results.
- Show, season, artist, and album upserts. They run whenever their folder changes, as today.
- A failed item keeps its old fingerprint. As today, it isn't retried until its folder changes again or a `force` scan runs.

## Known limits

- A crash between the upsert and the index call leaves a matching fingerprint and a stale search document. A `force` scan recovers it.
- `addDocumentsInBatches` resolves when Meilisearch accepts a task, not when it finishes. A task that fails inside Meilisearch later isn't caught.
- Edits that restore the old mtime (tag editors with "preserve timestamp") are invisible. The folder gate already misses them, so the item gate never runs. Follow-up issue: add `ctimeMs` to both gates.

## Decisions (design review, 11/01/2026)

| #   | question                                         | decision                                                                   |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Cover scanner code changes, not just files?      | One widened `v`, bumped by hand                                            |
| 2   | Parent fields in skipped children's documents?   | No drift allowed. Parent push-down, in the prerequisite PR                 |
| 3   | Album derivation input for skipped tracks?       | Keep the tag read; skip ffprobe and the upsert                             |
| 4   | Recover skipped items after a lost search index? | Forced rescan after a fresh index, in the prerequisite PR                  |
| 5   | Detect edits that preserve mtime?                | Out of scope; follow-up issue                                              |
| 6   | Fingerprint write vs. search indexing failure?   | Keep it in the upsert; clear it if indexing throws; crash is a known limit |

## Tests

- **Prerequisite PR:**
  - a show upsert updates `grandparent` on every episode document, including episodes in unchanged season folders
  - album and artist upserts update their tracks' documents
  - a freshly created `programs` index forces the next scan of each library, once, and the flag survives a restart
- **Fingerprint unit tests** (pure function over `{ name, stats }[]`):
  - each part changes when its file's mtime or size changes, and only that part
  - adding or removing a sidecar changes its part
  - movie shared names land in `metadata` and `artwork`
  - order of the directory listing doesn't matter
- **Scanner tests** (mock style of `LocalOtherVideoScanner.test.ts`, temp dir on disk):
  - add a file next to an existing item, rescan, and the existing item gets no probe and no upsert
  - NFO edit, new `.srt`, new `-thumb.jpg`, and a touched media file each reprocess the item
  - `force` reprocesses an unchanged item
  - a stored row with `state = 'missing'` reprocesses
  - an indexing failure clears the fingerprint, and the next scan reprocesses the item
  - music: an album rescan with an unchanged track keeps that track's genres on the album and doesn't probe the track
- **Repository test** for the batch lookup: returns only rows for the given media source and keys.
- **Migration**: the column exists and existing rows read as `NULL`.

## Docs

- `docs/configure/media_sources/local/index.md`: describe per-item skipping, and say that a `force` rescan always reprocesses.
- Release note: after upgrade, items have no fingerprint yet. Each folder's items get a full pass the first time that folder changes or a `force` scan runs.

## Out of scope

- Per-part work (#2407).
- Remote media sources.
- Content hashing.
- Edits that preserve mtime (follow-up issue).
- The shared `external_key` for multi-episode files.
- Scan scheduling.

## Order of work

1. Prerequisite PR: parent push-down and the forced rescan after a fresh index, with tests.
2. Migration and `AllProgramFields`.
3. Fingerprint function and its unit tests.
4. Batch lookup in the program repository (Drizzle) and its test.
5. Gate helper on `FileSystemScanner`, including the clear-on-index-failure step.
6. Wire the other-video scanner first, with scanner tests. It's the simplest path and already has a test harness.
7. Music video, movie, TV.
8. Music with partial skipping.
9. Docs and release note.
