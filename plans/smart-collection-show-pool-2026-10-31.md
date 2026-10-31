# Smart Collection show pools — #117

## Scope and completion

API-only follow-up to #115 for #58. The user authorized implementation, focused
checks and a review PR, with no deployment. #58 stays open until the preset
builder (#115) and this show-pool follow-up both land. UI remains deferred to
upstream's redesign. #118, #119 and #120 remain separate exploration issues.

## Mechanism

Variety accepts exactly one of explicit `showIds` or `showCollectionId`. The
collection path emits two ordinary random slots: a Smart Collection slot with
`programGrouping: "show"` and the existing wildcard slot. Each has a dynamic
program count of two; optional existing after-show pods apply to both.

The collection ID stays in the schedule. `SlotSchedulerHelper` resolves it at
generation time using existing search and descendant loading, with strict
resolution for show pools. `ShowPoolProgramIterator` groups matching playable
episodes by show, shuffles the shows with random-js and retains an existing
ordered episode iterator per show. A turn consumes two episodes before moving
to the wildcard slot. Each eligible show gets one turn per shuffle cycle;
reshuffling retains its episode position within that generation.

Season/episode filters do not widen to the show's full catalog. Movies and
shows with fewer matching playable episodes than the group size are excluded.
No eligible show fails generation. Episodes wrap using existing ordered-iterator
behavior. Show identity and group size distinguish iterator keys for linking.
Existing flat collections and explicit-show presets retain their behavior.

A generated lineup remains fixed until replacement/regeneration through the
existing lifecycle. Separate generations start fresh episode cursors; durable
continuation and nearby-repeat avoidance are not part of this slice.

## Evidence

- Reproduced the flat-shuffle mismatch: seed 42 with three unequal-sized series
  produced four mixed-show pairs out of six and an out-of-order same-show pair.
- Added one unit check at the new iterator owner for that concrete failure:
  same-show pairs, ordered progression and one turn per show despite unequal
  episode counts, across five cycles.
- Existing random scheduler, pod and linked-slot suites plus that unit check:
  51 passed.
- Bounded direct exercise using copied Colony Drop metadata: show, season and
  episode collection results, ads, membership refresh, stable prior lineup,
  no eligible show, API serialization/validation and incompatible linked modes.
  Checked main-pair/wildcard-pair order, per-show progression, show-level fairness,
  whole durations and same-seed replay.
- The direct exercise ran real collection expansion and scheduling code with
  local catalog/search stubs. It did not query live Meilisearch, save a live
  channel, scan media or verify playback.

Shared types build, server/web typechecks, generated OpenAPI/client,
changed-file lint and diff checks passed. Existing programming API suites added
5 passing checks. The 70 time-slot checks passed under `TZ=UTC`. In the local
timezone, two time-slot checks failed (padding alignment and a one-hour excess
in multi-day duration); both also failed after restoring #115's unchanged
ProgramIterator, slotSchedulerUtil and SlotSchedulerHelper. This is inherited
and timezone-sensitive; no time-slot fix is included.

A clean-context review follows the recoverable commit. Full CI runs on the host
runner; the PR is stacked on #115 until its parent lands.
