# Issue 45: marker refresh and repeated-scan check

Status: implemented and verified on copied data; not deployed. Base: `df6ac3592609f3a134048c2def891d3398d4e37c`.

## Outcome and invariant

Plex marker and chapter changes must be saved by a normal movie/episode scan even when file metadata and `updatedAt` stay unchanged. An identical second scan must stop saving programs and submitting search updates. Existing metadata must refresh without a separate recurring fixer.

The investigation reproduced unchanged fingerprints after adding, removing, retiming, or changing the final flag of credits markers. Changing `updatedAt` was detected. This establishes that the old scanner misses marker-only changes when other hashed fields stay unchanged; it does not establish which Plex operations update that timestamp.

The Plex canonicalizer now hashes the chapter/marker fields consumed by the importer. It sorts their representations, ignores incidental chapter IDs and response order, and normalizes absent arrays to empty arrays. An explicit section changes old fingerprints once, including items without markers. The movie scanner compares the fetched full metadata, matching the episode/other-video paths, instead of the library listing that does not request chapters/markers.

This is one change-detection fix. Jellyfin/Emby still use their provider ETags. No schema, dependency, endpoint, scan schedule or startup job changes.

## Copied-data application check

A disposable container ran the built candidate with an online SQLite backup and copied configuration/search snapshot. The fixed sample was 12 movies and 13 episodes from one season; 19 items had Plex credit markers. Plex detail responses were recorded once and replayed unchanged, with chapters/markers omitted from listing responses as the normal listing request does not request them. Non-sample copied programs/groupings were removed from the scanned library scope, not deleted. Reporting, automatic repair, subtitle extraction for copied channels and smart filler bindings were disabled only in the copied configuration. Production was not changed.

These were normal library scan API requests without force. Real conversion, database upserts, search indexing and scan follow-up tasks ran. SQLite triggers counted program writes; search task history counted indexing. Each pass made the same 45 replay GETs. No unrecorded requests or failed search tasks occurred.

| Pass                                                                    | Program writes | Search tasks | Scan plus index time |
| ----------------------------------------------------------------------- | -------------: | -----------: | -------------------: |
| Initial refresh                                                         |             25 |           25 |             13.364 s |
| Identical second scan                                                   |              0 |            0 |              0.513 s |
| Change one movie's credit start and final flag, holding updatedAt fixed |              1 |            1 |              1.519 s |
| Identical scan after that change                                        |              0 |            0 |              0.517 s |

All 347 chapter/intro/outro rows for the 25 sampled programs matched the expected input timing, type, index, title and final flag after every pass. Only the selected movie changed during the marker-only pass. Database integrity and foreign keys passed. Production container identity, image, start time and restart count were unchanged.

The container was limited to 4 GiB and two CPUs. Peak sampled anonymous memory across the four passes was 693.62 MiB; memory did not return to its initial level during these short observations. This is not a sustained memory/leak measurement. Timings use replayed metadata, not live Plex transport, and do not predict full-library first-scan duration. Normal requests already fetch full metadata; the first post-upgrade scan nevertheless re-saves all Plex movies/episodes and can be substantially longer due to database, subtitle and indexing work. A previous operator report of an eight-hour forced reimport is a warning about this cost, not a measured duration for this fix.

Probe binary SHA-256: `e3496651b2cc473a9ceb3663041d6a376cdd8799108e92743c84237800e1fb56`. Detailed private evidence and probe scripts: deployment companion `deployment/marker-refresh-20261030/`.

## Validation and remaining boundary

- 160 focused tests passed: canonicalizer, movie scanner and Plex API.
- Server production typecheck passed.
- Focused regression types checked separately with the repository declarations.
- Changed-file lint, formatting and diff checks passed.
- The repository-wide test typecheck is blocked by existing MPEG-TS fixtures interpreted as TypeScript and an existing inferred-type error in `tests/support/seed.ts`; this fix does not change those files.

The repeat-scan gate is satisfied on copied data. Review and CI precede any merge, and live deployment/whole-library timing remain unperformed. No full live scan is authorized by this probe result alone.
