# Server test typecheck repair — 2026-10-30

Status: bounded configuration/shared-fixture repair ready for review. Remaining diagnostics are deferred for operator direction. Separate branch from PR #85, based on main `1e8eae83ff1314f542879694d3bf4e3b47911486`. No production, CI workflow, assertion, skip, or test timeout changes.

## What changed

- `server/tsconfig.test.json` excludes only `src/testing/ffmpeg/fixtures/**`, whose tracked `.ts` files are MPEG transport-stream media. FFmpeg helper TypeScript and tests remain included. Existing declaration and strictness checks remain enabled.
- `server/tests/support/seed.ts` explicitly returns Fastify's exported `LightMyRequestResponse` from the HTTP helper, fixing TS2883 without disabling declaration checking. Both schedule builders supply the existing API default `overflow: { type: 'duration', maxMs: 0 }`.
- `server/src/testing/fakes/entityCreators.ts` now supplies the required database-record fields. Nullable fields use null, optional channel features default off, and caller overrides remain last. Channel fixtures preserve Kysely numeric booleans versus Drizzle booleans. Program defaults are shared between those scalar-compatible representations and checked against the existing ProgramDao type. These are detached in-memory records, not a substitute for the seed helpers that insert related database rows.

No assertions, casts to bypass errors, suppression comments, or compiler safety reductions were added. Existing fake IDs, random title/duration generation, and overrides remain intact.

## Typecheck result

Command from repository root:

```sh
pnpm exec tsc --noEmit -p server/tsconfig.test.json --noErrorTruncation false
```

**Still fails: 629 diagnostics across 78 files.** The earlier diagnostic probe exposed 641 across 80 files by temporarily excluding binary fixtures and disabling declaration checking. This committed repair fixes the declaration blocker instead and runs with declaration checking enabled.

The comparison removes exactly 12 semantic diagnostics: 10 from the five shared entity constructors (assignment and satisfies diagnostics for each), plus two missing-overflow diagnostics from the schedule seed builders. No new file/code diagnostic counts appeared. The binary parse failures and TS2883 early blockers are also resolved; those were outside the 641 semantic total. The three changed files have no remaining diagnostics.

This is a small, truthful reduction; the remaining errors are not automatically fixed by repairing shared constructors because callers and many test-local fixtures have their own incompatible shapes.

## Runtime validation

Node 22.23.4 / TypeScript 7.0.2 / pnpm 10.28.0. Ran all nine existing test files importing entityCreators plus `tests/lineupResponseEquivalence.test.ts`, which exercises the shared seed helpers and HTTP save path.

- Before entity-constructor repair, after config/seed correction: 202 tests, 200 pass, two fail.
- After entity-constructor repair: the same 202 names and outcomes, 200 pass, the same two fail.
- Existing failures in `TimeSlotService.test.ts`: `per-slot pad override does not starve the following slot` and `schedules across multiple days`.
- Both cases pass when rerun with `TZ=UTC`; the original runs used the workstation's America/Chicago timezone on 2026-10-30. This demonstrates timezone-sensitive tests; it does not settle whether each underlying scheduling expectation or implementation is correct. No timezone change was committed and neither failure was hidden or skipped.
- Formatting and diff checks pass. Normal lint-changed excludes `src/testing/*` and `tests/*`, so it reports no files for these helper changes; policy unchanged.

Focused runtime command from `server/` (the entityCreators imports determine the first nine paths):

```sh
pnpm exec vitest run src/services/scheduling/ShuffleProgramIterator.test.ts src/services/scheduling/TimeSlotService.test.ts src/services/scheduling/selectWholePod.test.ts src/services/scheduling/TimeSlotService.outOfRange.test.ts src/services/scheduling/customShowMidRoll.test.ts src/services/scheduling/WeightedFillerProgramIterator.test.ts src/services/scheduling/RandomSlotsService.test.ts src/services/XmlTvWriter.test.ts src/stream/StreamProgramCalculator.test.ts tests/lineupResponseEquivalence.test.ts
```

## Remaining work — not implemented

- Test-local fixture/type drift: missing fields, old object shapes, removed properties, and incompatible mock signatures. Largest concentrations are scheduling, stream selection, database fixtures, XMLTV, and stream construction.
- Undefined handling: assertions or indexed array/map lookups lack a type-level existence check. Each needs review against the intended assertion rather than a blanket non-null assertion.
- Imports/compiler interactions: wrong or stale type imports, and 30 TS2877 alias-import/extension rewrite diagnostics. Resolve the intended no-emit test compiler contract before mass-editing imports.
- Unused declarations and smaller individual errors remain, including two unused helper/script functions. Do not bundle these into a new subsystem or loosen the checker.
- The two timezone-sensitive scheduling tests need a separate decision about clock/timezone expectations.

CI currently checks production server types and executes tests; it does not enforce this full test typecheck. Enabling it is deferred until the remaining failures have an agreed disposition. PR #85 is untouched.

## Remaining diagnostics by file

Counts are compiler diagnostics, not independent defects. Repeated messages may share one fixture cause.

| File                                                                      | Diagnostics |
| ------------------------------------------------------------------------- | ----------: |
| `server/src/services/scheduling/TimeSlotService.test.ts`                  |         150 |
| `server/src/services/scheduling/FillerPickerV2.test.ts`                   |          85 |
| `server/src/ffmpeg/StreamSelectionEvaluator.test.ts`                      |          43 |
| `server/src/db/ProgramDB.test.ts`                                         |          33 |
| `server/src/services/XmlTvWriter.test.ts`                                 |          30 |
| `server/src/ffmpeg/FfmpegStreamFactory.test.ts`                           |          28 |
| `server/src/stream/StreamProgramCalculator.test.ts`                       |          28 |
| `server/src/services/scheduling/RandomSlotsService.test.ts`               |          19 |
| `server/src/services/scheduling/slotGroupValidator.test.ts`               |          15 |
| `server/src/db/ChannelDB.test.ts`                                         |          13 |
| `server/src/stream/ProgramStreamDetailsFetcher.test.ts`                   |          13 |
| `server/src/services/TvGuideService.test.ts`                              |          10 |
| `server/src/services/StreamSelectionProfileResolver.test.ts`              |           9 |
| `server/src/tasks/ReconcileProgramDurationsTask.test.ts`                  |           8 |
| `server/src/ffmpeg/FfmpegPlaybackParamsCalculator.test.ts`                |           7 |
| `server/src/services/CustomShowSyncService.test.ts`                       |           7 |
| `server/src/db/CustomShowDB.test.ts`                                      |           6 |
| `server/src/external/plex/PlexApiClient.test.ts`                          |           6 |
| `server/src/services/scanner/MediaSourceOtherVideoScanner.test.ts`        |           6 |
| `server/src/api/streamApiHlsConnections.test.ts`                          |           5 |
| `server/src/ffmpeg/builder/pipeline/nvidia/NvidiaScaler.test.ts`          |           5 |
| `server/src/nfo/TvEpisodeNfoParser.test.ts`                               |           5 |
| `server/src/services/scanner/MediaSourceMusicArtistScanner.test.ts`       |           5 |
| `server/tests/fastify-static-serving.test.ts`                             |           5 |
| `server/src/ffmpeg/builder/pipeline/BasePipelineBuilder.test.ts`          |           4 |
| `server/src/services/EmptyTrashService.test.ts`                           |           4 |
| `server/src/services/TrashRepairService.test.ts`                          |           4 |
| `server/src/util/basicAuth.test.ts`                                       |           4 |
| `server/tests/uploadImage.test.ts`                                        |           4 |
| `server/src/ffmpeg/SubtitleStreamPicker.test.ts`                          |           3 |
| `server/src/ffmpeg/builder/pipeline/hardware/QsvPipelineBuilder.test.ts`  |           3 |
| `server/src/services/MediaSourceLibraryRefresher.test.ts`                 |           3 |
| `server/src/types/featureFlagsRequest.test.ts`                            |           3 |
| `server/src/api/nativePlaybackApi.test.ts`                                |           2 |
| `server/src/db/MediaSourceDB.test.ts`                                     |           2 |
| `server/src/external/BaseApiClient.test.ts`                               |           2 |
| `server/src/ffmpeg/builder/MediaStream.test.ts`                           |           2 |
| `server/src/ffmpeg/builder/filter/watermark/WatermarkScaleFilter.test.ts` |           2 |
| `server/src/migration/lineups/MovieSlotToCustomShowMigration.test.ts`     |           2 |
| `server/src/services/scanner/ExternalCollectionScanner.test.ts`           |           2 |
| `server/src/services/search/MediaSourceNameSearchMutator.test.ts`         |           2 |
| `server/src/tasks/BackupTask.test.ts`                                     |           2 |
| `server/src/tasks/fixers/NormalizeLanguageCodesFixer.test.ts`             |           2 |
| `server/src/types/channelWriteValidation.test.ts`                         |           2 |
| `server/scripts/download-meilisearch.ts`                                  |           1 |
| `server/src/api/mediaSourceApi.test.ts`                                   |           1 |
| `server/src/commands/MaterializeLineupCommand.test.ts`                    |           1 |
| `server/src/db/converters/ProgramMinter.test.ts`                          |           1 |
| `server/src/external/jellyfin/JellyfinApiClient.test.ts`                  |           1 |
| `server/src/ffmpeg/builder/filter/SubtitleFilter.local.test.ts`           |           1 |
| `server/src/ffmpeg/builder/pipeline/hardware/QsvPipeline.local.test.ts`   |           1 |
| `server/src/ffmpeg/builder/pipeline/nvidia/NvidiaPipeline.local.test.ts`  |           1 |
| `server/src/services/MeilisearchService.test.ts`                          |           1 |
| `server/src/services/SmartFillerListService.test.ts`                      |           1 |
| `server/src/services/scheduling/TimeSlotService.outOfRange.test.ts`       |           1 |
| `server/src/services/scheduling/customShowMidRoll.test.ts`                |           1 |
| `server/src/services/search/LanguageCodeSearchFilterMutator.test.ts`      |           1 |
| `server/src/services/search/LibraryNameSearchMutator.test.ts`             |           1 |
| `server/src/stream/SessionManager.test.ts`                                |           1 |
| `server/src/stream/hls/BaseHlsSession.test.ts`                            |           1 |
| `server/src/stream/hls/HlsPlaylistMutator.test.ts`                        |           1 |
| `server/src/tasks/OnDemandChannelStateTask.test.ts`                       |           1 |
| `server/src/testing/ffmpeg/FfmpegIntegrationHelper.ts`                    |           1 |
| `server/src/types/timeSlotScheduleValidation.test.ts`                     |           1 |
| `server/src/util/mediaSources.test.ts`                                    |           1 |
| `server/src/util/openapiUtil.test.ts`                                     |           1 |
| `server/src/util/strings.test.ts`                                         |           1 |
| `server/tests/channelProgrammingValidation.test.ts`                       |           1 |
| `server/tests/channelWriteContract.test.ts`                               |           1 |
| `server/tests/channels.test.ts`                                           |           1 |
| `server/tests/featureFlagsPartialUpdate.test.ts`                          |           1 |
| `server/tests/lineupResponseEquivalence.test.ts`                          |           1 |
| `server/tests/nativePlayback.test.ts`                                     |           1 |
| `server/tests/perf/guideRebuildLag.test.ts`                               |           1 |
| `server/tests/perf/slotSaveLag.test.ts`                                   |           1 |
| `server/tests/server.test.ts`                                             |           1 |
| `server/tests/settingsPartialUpdate.test.ts`                              |           1 |
| `server/tests/testServer.ts`                                              |           1 |
