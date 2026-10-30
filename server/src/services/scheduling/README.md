# Ordered after-show pods

The program-count path in `RandomSlotsService` materializes an ordered post-program recipe into the generated lineup. `postProgramPod` contains positions; each position supplies one or more `fillerListIds` and an optional `count` (default 1, the same as repeating the position). Selection chooses one list per draw, then one complete clip from that list, skipping clips already in the break while the pool offers another; a pool smaller than the break repeats. Array order is playback order. The complete break contributes to `PaddedProgram.totalDuration` before the next program is placed.

No position has a fixed commercial, promo or closer role. The supplied recipe must have at least one position; omit `postProgramPod` to retain legacy post-filler behavior. Selections are made when the schedule is generated or regenerated, then saved in the ordinary lineup. Playback does not draw a new selection for each airing.

This is schedule-time materialization, using the existing uniform shuffle-bag iterators in `ProgramIterator` and `slotSchedulerUtil`. Repeated positions using the same list reuse its iterator. No new rotation algorithm, background controller or timeline service is involved. Pool exhaustion is an implementation policy of the existing iterator, not an editorial exposure requirement.

`CommonSlots.ts` owns the recipe contract, `SlotSchedulerHelper` resolves its pool references, and `SlotImpl.selectPostProgramPod` delegates to the shared `selectWholePod` selector. A recipe replaces the legacy single post-program selection; existing head, pre and tail filler retain their meanings. Without a recipe, scheduling behavior is unchanged. When an existing mid-roll configuration splits a program, its pod stays after the final segment.

Only program-count slots support pods. Fixed-duration and time-slot schedules reject them rather than fitting, trimming or dropping configured positions. Missing pools fail existing reference validation; a selected pool with no playable whole clip fails generation. Clips retain their full catalog durations. Generation produces an ordinary saved lineup, with the existing playback and guide behavior. This change adds no UI, database migration or live deployment automation.

## One-block generation

`POST /api/programming/generate-block` performs one ordered expansion through
`BlockGenerationService`. The request has an `entries` array and an optional
integer-array `seed`. Each entry is either `{ "type": "program", "programId":
"<catalog UUID>" }` or `{ "type": "break", "positions": [{ "fillerListIds":
["<pool UUID>"] }] }`. Break positions use the same recipe schema as pods.
Any position can name multiple eligible pools; no position has a fixed role.

The service resolves catalog IDs and uses `selectWholePod` with the existing
uniform shuffle-bag iterators from `slotSchedulerUtil` / `ProgramIterator`.
Each pool has one iterator shared across the request's breaks. Input order and
repeated programs are retained. Whole catalog durations determine every emitted
entry, with no clipping, padding, horizon, or schedule-count sections.

The response contains `lineup` (ordinary condensed content/filler entries),
`programs` (the materialized program map), `startTimeOffsets` (one relative start
per entry, in milliseconds), `durationMs` (their sum), and `seed`. A caller can
place these entries in an external lineup and save it using the existing manual
programming API. Generation does not save a lineup, change a channel clock, or
persist a recipe. Guide handling of post filler remains unchanged.

Empty `entries` produces an empty block; an explicitly supplied break must have
at least one position and each position at least one pool. Schema errors,
missing references, explicit programs without a finite positive duration, pools
with no positive-duration members, or selected content that cannot be
materialized fail the request. There is no successful partial block. This uses
catalog metadata; it does not probe media files or promise decoder health.

The same seed and unchanged catalog/pool ordering reproduce a request. Iterator
state exists only during that request; separate requests do not continue a
shared rotation. Selection occurs at generation, not on each airing. Source
queries/cursors, saved blocks, UI, placement/Apply, renewal, and live cutover are
outside this endpoint.

## Refresh saved after-show filler

`POST /api/channels/:id/programming/refresh-fillers` accepts
`{ "fillerListIds": ["pool UUID"], "seed": [123] }` (seed optional).
It replaces existing `post` filler positions belonging to those pools with whole
clips drawn from their current membership. `RefreshChannelFillerCommand` reuses
`BlockGenerationService` and its request-scoped shuffle bags. It does not change
programs, their order, break positions, or positions from other pools. Promos and
closers have no special meaning: include their pools only to refresh them too.

`LineupRepository.applyFillerRefresh` keeps the item playing at save time and
adjusts the channel start time to preserve its elapsed playback position exactly.
Full replacement durations determine the new loop length and the channel guide
is queued for refresh. The response gives matched/refreshed position counts,
the protected current index, duration, start time, and generation seed. The saved
schedule seed is cleared because this edited lineup no longer reproduces that
schedule. Channel settings and the saved schedule definition remain unchanged.

This is an explicit edit, not automatic renewal or a new draw on every airing.
A finite lineup can have fewer positions than its pool has clips. Unselected clips
remain eligible for a later refresh. Only the saved pool ID is known; this does
not reconstruct multi-pool recipe alternatives or infer roles for older entries.
A missing pool, empty playable pool, or requested pool without saved after-show
positions fails before saving. A channel edited during generation must be retried.
On-demand channels and time-slot schedules are rejected because their clock or
fixed-time contract differs from a looping lineup. This uses the existing SQLite
and JSON lineup persistence boundary, not a new cross-store transaction system.
