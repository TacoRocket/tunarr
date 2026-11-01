# Local scan: per-item fingerprint (#2208)

> **Status (11/01/2026):** Planned. Branch `feat/local-scan-item-fingerprint`. Tracker #2209; follow-up #2407.

## Goal

- Skip ffprobe, metadata reads, and every DB write for a local item whose files are unchanged.
- "Files" means the whole logical item: media file, NFO, subtitle sidecars, per-item artwork.
- v1 is all-or-nothing. Any changed part reprocesses the item exactly as today.
- Store the parts separately so #2407 can narrow the work per part without a migration.

## Current behavior

- Folder gate: `LocalFolderCanonicalizer` hashes folder mtime plus each entry's name and mtime. An unchanged folder is skipped.
- A changed folder reprocesses every item in it: one ffprobe and ~10 statements per item.
- `force` bypasses the folder gate and reprocesses the whole library.
- No per-item "last seen" record exists. `program.updated_at` is rewritten on every upsert.

The folder gate stays. The item gate runs inside a folder that already failed the folder gate, or during a `force` scan.

## Design

### Logical item membership

An item's files are all in the media file's own directory.

| part | files |
| --- | --- |
| `video` | the media file |
| `metadata` | `<stem>.nfo`; plus `movie.nfo` for movies |
| `subtitles` | stem-prefixed files with a subtitle extension (`.srt`, `.ass`, `.ssa`, `.vtt`) |
| `artwork` | stem-prefixed image files; plus `poster`, `fanart`, `banner`, `landscape`, `folder` images for movies |
| `other` | any other stem-prefixed file |

- "Stem-prefixed" uses the same rule as `LocalSubtitlesService.findExternalSubtitles`: `name.startsWith(stem)`, no separator. The fingerprint must cover at least everything discovery can pick up.
- The prefix rule over-includes (`Ep1` matches `Ep10.mkv`). That only causes extra reprocessing, which is safe.
- Shared names (movie NFO and artwork) come from the scanner, so each scanner declares its own extras.
- `other` exists so an unknown sidecar still invalidates the item. #2407 treats an `other` change as a full reprocess.

### Fingerprint value

- Each part is a SHA-1 over its files sorted by name, hashing `name`, `mtimeMs`, and `size` for each file.
- A part with no files hashes to a fixed empty value, so adding the first sidecar changes it.
- The stored value is JSON: `{ "v": 1, "video": "…", "metadata": "…", "subtitles": "…", "artwork": "…", "other": "…" }`.
- `v` is the membership-rule version. Bumping it invalidates every stored fingerprint.

### Storage

New nullable column `program.local_fingerprint` (text, JSON).

| option | lookup | verdict |
| --- | --- | --- |
| `program` | `(source_type, media_source_id, external_key)` is already unique-indexed; `external_key` is the file path for local items | **chosen** |
| `program_media_file` | no index on `path`; `local_media_folder_id` is not set by the other-video scanner | rejected |

- Add `program.localFingerprint` to `AllProgramFields`, so `ProgramUpsertSetClause` writes it on upsert.
- Remote sources never set it, so they write `NULL`. That's harmless.
- The fingerprint is written by the same upsert as the program, so the two can't drift apart.
- Migration via `pnpm drizzle-kit generate`.

### Gate

Per folder (or per directory, for recursive season and album walks):

1. List and stat the directory once. Reuse the stats for every item in it.
2. Batch-read stored fingerprints: one query, `external_key IN (…)` for the folder's media files, returning `externalKey`, `localFingerprint`, `state`.
3. For each item, compute the fingerprint **before** any other work.
4. Skip the item when all of these hold:
   - `context.force` is false
   - a stored row exists with `state = 'ok'`
   - the stored JSON equals the computed JSON, including `v`
5. Otherwise process as today and set `dao.program.localFingerprint` to the value from step 3.

Notes:
- Computing before processing is conservative. A file that changes mid-scan doesn't match the stored value next time, so it gets reprocessed.
- `state = 'ok'` matters. A file that goes missing and comes back with the same mtime and size must be reprocessed, or it stays `missing` forever.
- A stat failure counts as changed.
- Skipped items keep their search documents, artwork rows, and subtitle rows untouched.

### Per-scanner wiring

| scanner | per-item path | extra notes |
| --- | --- | --- |
| Other video | `scanVideoFile` | none |
| Music video | `scanVideoFile` | none |
| Movie | `handleVideoFile` | movie shared names; drop the `findExistingLocalProgram` read for skipped items |
| TV | `handleEpisodeFile` | season walk is recursive, so group stats by `parentPath`; a multi-episode file shares one `external_key` row |
| Music | `scanTrack` | see below |

**Music needs partial skipping.** `scanAlbum` derives album genres and release date from every track's embedded tags (`rawMetadata`) on each album scan. A fully skipped track would drop its genres from the album. So for an unchanged track:
- still run `parseFile` (tag read, no subprocess) and return its `rawMetadata` for the album derivation
- skip ffprobe, the track upsert, and its search indexing

This keeps album output identical and still removes the expensive part.

## Unchanged behavior

- Folder gate and folder `canonical_id` updates.
- The missing-program sweep (`getProgramInfoForMediaSourceLibrary` + `updateProgramsState`). It checks file existence, not scan results.
- Show, season, artist, and album upserts. They run whenever their folder changes, as today.
- A failed item keeps its old fingerprint. As today, it isn't retried until its folder changes again or a `force` scan runs.

## Tests

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
- The shared `external_key` for multi-episode files.
- Scan scheduling.

## Order of work

1. Migration and `AllProgramFields`.
2. Fingerprint function and its unit tests.
3. Batch lookup in the program repository (Drizzle) and its test.
4. Wire the other-video scanner first, with scanner tests. It's the simplest path and already has a test harness.
5. Music video, movie, TV.
6. Music with partial skipping.
7. Docs and release note.
