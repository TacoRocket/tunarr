# Ordered after-show pods

The program-count path in `RandomSlotsService` materializes an ordered post-program recipe into the generated lineup. `postProgramPod` contains positions; each position supplies one or more `fillerListIds` and an optional `count` (default 1, the same as repeating the position). Selection chooses one list per draw, then one complete clip from that list, skipping clips already in the break while the pool offers another; a pool smaller than the break repeats. Array order is playback order. The complete break contributes to `PaddedProgram.totalDuration` before the next program is placed.

No position has a fixed commercial, promo or closer role. The supplied recipe must have at least one position; omit `postProgramPod` to retain legacy post-filler behavior. Selections are made when the schedule is generated or regenerated, then saved in the ordinary lineup. Playback does not draw a new selection for each airing.

This is schedule-time materialization, using the existing uniform shuffle-bag iterators in `ProgramIterator` and `slotSchedulerUtil`. Repeated positions using the same list reuse its iterator. No new rotation algorithm, background controller or timeline service is involved. Pool exhaustion is an implementation policy of the existing iterator, not an editorial exposure requirement.

`CommonSlots.ts` owns the recipe contract, `SlotSchedulerHelper` resolves its pool references, and `SlotImpl.selectPostProgramPod` delegates to the shared `selectWholePod` selector. A recipe replaces the legacy single post-program selection; existing head, pre and tail filler retain their meanings. Without a recipe, scheduling behavior is unchanged. When an existing mid-roll configuration splits a program, its pod stays after the final segment.

Only program-count slots support pods. Fixed-duration and time-slot schedules reject them rather than fitting, trimming or dropping configured positions. Missing pools fail existing reference validation; a selected pool with no playable whole clip fails generation. Clips retain their full catalog durations. Generation produces an ordinary saved lineup, with the existing playback and guide behavior. This change adds no UI, database migration or live deployment automation.

## Smart Collection show pools

`ShowPoolProgramIterator` implements a shuffle bag of shows with one existing
`ContentProgramOrderedIterator` per show. `random-js` shuffles the show bag;
each turn consumes the slot's program count from one episode iterator before
advancing the bag. A full pass reshuffles shows without resetting episode
positions. Episode exhaustion uses the existing ordered iterator's wrap.

The opt-in `programGrouping: "show"` field belongs to Smart Collection random
slots with dynamic duration and ascending `next` order. `SlotSchedulerHelper`
resolves the saved collection on each generation. Only those resolved episodes
are grouped, preserving show, season and episode filters. Duplicate program IDs
are collapsed; non-episodes, unplayable episodes and shows shorter than the group
size are excluded. No eligible show is a generation error. Show-pool searches
use strict collection resolution so an invalid saved filter cannot widen to the
whole library. Flat collection selection order retains its existing behavior.
Collection expansion preserves every membership when a program is matched both
directly and through a show or season, emitting each program once per pool.

Iterator keys distinguish grouped and flat collections and group sizes, so
linked slots cannot share incompatible iteration state. State is local to one
generation. Membership refresh does not mutate a saved lineup, and durable
episode continuation, wildcard repeat avoidance and UI are separate work.

## Seed channel generation

`SeedChannelService` implements content-based recommendation with weighted random
sampling using the existing random-js seeded generator. Meilisearch supplies a
paginated catalog of show/movie metadata; Tunarr owns selection, channel-local
play-count weighting, playable episode expansion and lineup materialization.
`POST /api/programming/generate-seed-channel` returns an ordinary preview and
never records history or saves a channel.

Metadata similarity is the sum of weighted Jaccard overlaps: genres 4, tags 6,
cast 2, directors 3 and studios 1. Release year does not affect selection.
The final similarity averages the best seed match and
the previous title match. Familiarity multiplies this by
`1 + familiarity/100 * min(4, log2(1 + channelPlays))`. Counts are summed per show
for episodes and per program for movies, excluding filler history. This is a
bounded playback-start preference boost, not a measured-watch-time model.

`SeedChannelScorer` normalizes metadata and caches each candidate's best-seed
score once per request. Each pick computes only the preceding-title match (and the watched-title
match for a continuation);
explanation strings are built for the selected title. Setup and scoring yield
through Tunarr's existing event-loop throttle every 100 catalog items so long
previews can service other requests. The weights, seed tie order, candidate order
and random draws are unchanged. These caches live only for this generation.

Explicit seeds start the lineup. Other related titles get a turn before returning
to the previous title. Each show selection draws uniformly from its eligible
episodes across seasons using the same seeded random generator. Seed shows also
draw randomly; an explicitly selected seed episode is honored exactly.
The last twenty history/generated program IDs are excluded until no candidate
can supply an unused clip, then the window clears with a preview warning.
Empty or unplayable pools are excluded; missing seeds and no related playable
content return a visible validation error. The default metadata mode requires no
model. Neither mode adds a migration, global preference state or persistent
episode cursor.

The same draw seed reproduces a result only against unchanged catalog/history
and channel settings. Catalog membership can change during generation; final
materialization rejects vanished programs instead of publishing broken entries.

### Playback-driven continuation

`GrowSeedChannelTask` extends opt-in channels from a new main-program history
record. `StreamProgramCalculator` schedules the task only after creating that
record; the existing duplicate-play check and per-channel `MutexMap` serialize
the path. The task snapshots the lineup before metadata queries.

A continuation selects one complete item without prepending the seeds. Its
similarity averages the best original-seed match, preceding scheduled title
match, and triggering watched-title match. Existing familiarity applies after
that average. Pending current/tail program IDs are excluded. Per-occurrence
`selectionExplanation` stores the trigger and actual match reasons at selection
time; it never lives in shared program metadata.

`db/channel/seedGrowth.ts` owns modulo-clock interpretation. Below the soft
ahead target, `LineupRepository.applySeedGrowth` retains the current item and
future tail, appends the whole recommendation and rebases the start time to the
current item's actual start. It rechecks the snapshot, clock, target and most
recent applied play ID before publishing. This uses the existing SQLite plus
lineup-JSON write boundary, not a new cross-store transaction. It then requests
a channel-scoped guide refresh. No timer fills the queue without playback.

Config and applied-play ID persist in optional lineup JSON fields; legacy
lineups stay disabled. Selection failures are logged without blocking playback;
publication uses the existing persistence boundary. One-off tasks are not a
durable job queue: a restart may lose an
unapplied addition. The next recorded play triggers a new attempt. On-demand,
offset, live relay and active time/random schedules have different clock/owner
contracts and cannot enable growth. Sources with offset followers also cannot
enable growth, because retiring aired entries could change a follower's playback.

### Rolling guide and bounded shortlist

Optional `seedGrowth.rolling` adds periodic replenishment to Balanced matching.
`RollSeedChannelsTask` runs every five minutes and at startup through the same
`GrowSeedChannelTask` lock and `LineupRepository.applySeedGrowth` publisher as
recorded starts. A refill preserves the current program and queued tail,
retires aired entries, and appends a batch of whole programs. Timer ticks never
insert play history or add scheduled titles to the interest profile.

`RollingSeedChannel.drawSeedShortlist` implements weighted sampling without
replacement using random-js, drawing up to `candidateCount` show/movie sources
from the existing eligible discovery mixture. `SeedChannelService` draws programs
from that shortlist with the existing scoring and repeat exclusions. This is
request-local state, rebuilt when a refill is needed, not a persisted chart or
an additional preference model. Exhaustion refreshes from remaining supported
sources with a warning; it never enables a uniform catalog fallback.

The default ahead window is six hours, extending toward twelve when remaining
movie airtime exceeds 30%. `rollingSeedTargetMs` clamps movie airtime divided by
the requested share between the minimum and maximum. Beyond the minimum,
selection prefers supported episodes in the shortlist. Without eligible episodes,
selection retains the supported pool and warns. The limit is soft: the final
whole program may cross it, and a movie-heavy queue may remain above the trigger.
At 0%, any movie airtime triggers the maximum; at 100%, only the minimum applies.

`TVGuideService` publishes only the saved absolute tail for rolling channels;
it does not project later repetitions. Playback retains the existing loop as
recovery when replenishment fails. Selection errors leave the saved queue intact,
are logged as task failures, and retry on a later tick. Publishing retains the
existing SQLite plus JSON boundary and rejects intervening lineup/clock edits.
Existing watch-driven settings remain unchanged unless rolling is explicitly
selected. No database migration or watch-duration tracking is added.

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

### Semantic seed scoring

Optional `recommendationMode: "semantic"` selects `SemanticSeedChannelScorer`.
Meilisearch retrieves the closest 49 available show/movie neighbors using the
`potion` embedder; the source itself occupies rank 1. The scorer uses reciprocal
rank (`1/rank`) and zero outside this 50-title shortlist, caching each context
source once per generation. The existing weighted draw, familiarity multiplier,
random episode pool and continuation rules then apply unchanged. This is
content-based retrieval and sampling, not a contextual bandit or learned viewer
profile. The rank weighting and shortlist size reproduce the initial Potion
trial policy; they are not calibrated similarity probabilities.

The optional mode also persists in `seedGrowth` and is forwarded for later
appends. Omitted mode remains metadata. Semantic mode fails visibly when the
embedder is disabled or unavailable. See `../search/README.md` for model ownership
and index lifecycle.

### Balanced mixture and reconstructed interests

`BalancedSeedChannelScorer` implements an exponentially weighted moving average
(EWMA) of title relationships. `BalancedSeedChannelHistory` selects the latest
`BalancedHistoryStartLimit` (50) starts after channel, filler and available-source
filters, ordered by played time and UUID, then reverses them into chronological
order. A JSON membership parameter avoids SQLite bind limits for large catalogs.
The SQL limit bounds returned starts and historical neighbor/scoring work; it does
not make the existing lifetime Familiarity aggregation or catalog work constant.
`SeedChannelService` passes that sequence to the scorer. An algebraic source-weight sum reproduces
`profile = 0.75 * profile + 0.25 * watchedRelation`, starting from the best seed
relationship. Repeated starts count separately. Meili retrieves each source's
semantic neighbors once per request; the existing metadata scorer supplies the
broader relationship profile. With 50 starts the remaining seed coefficient is
`0.75 ** 50`. Small raw coefficients do not guarantee equally small changes in
final probabilities after eligibility filtering and normalization. Lifetime
Familiarity and unavailable-history warnings still use the existing aggregate.
No durable cursor/profile or migration is added.

Each anchor's relationship is multiplied by its own connection support before
applying its EWMA coefficient. The sum is the interest/metadata affinity; support
is not applied again to the assembled profile. Scheduled predecessors contribute
no affinity and require no Balanced neighbor retrieval. Exploration separately
uses the EWMA-weighted support from seeds and watched titles. No tie gives zero; one broad tie (genre, studio or exact
nonempty rating) gives 0.25; multiple ties or tag/cast/director/semantic evidence
give 1. Each shared genre counts separately, other fields once, against the same
anchor. Metadata adds 0.25 for a matching rating and multiplies by 1.5 for two
or more ties. For non-seed watched anchors, supported semantic and metadata
self-matches are capped at the strongest other catalog match in their respective
pool. Caps are cached per watched source per request, with a throttled catalog
pass per source. Explicit seeds keep their self-match. Older watched anchors use
the same semantic cap in look-back. Familiarity remains separate.
Temperature applies `affinity ** (1 / temperature)` before Familiarity.

`SeedChannelDiscovery` normalizes four eligible pools. The default weights are
85.5% interests, 7.6% metadata, 1.9% support-weighted exploration and 5% look-back.
Exploration changes metadata/exploration at an 80/20 split inside the remaining
95%. Support-weighted exploration uses support times Familiarity, without
temperature. Unwatched predecessors cannot admit or boost candidates.
These support coefficients are policy, not calibrated confidence; Potion's
input includes genres, so two ties need not be independent evidence.

Look-back uses the best Potion reciprocal rank from original seeds and up to
three distinct non-seed older sources, times Familiarity. Subtracting the exact
latest-50 source counts from the existing lifetime counts identifies older starts
without loading all history rows. Sampling is weighted without replacement by
older counts, repeated per selection, with an independent seeded random stream.
Each draw prepares at most three extra older sources; cached retrievals can grow
across a long generation request. The 50-start bound still applies to current
profile reconstruction, not all request work. Missing sources are omitted.
An empty pool contributes zero and remaining enabled shares renormalize; zero
total weight is a validation error. No uniform catalog fallback remains.

Available program IDs are loaded once per Balanced request, then current/queued
and recent exclusions apply before normalization. A rejected stale program pool
is removed and the mixture is recalculated. Initial generation preserves the
existing last-20 repeat policy; continuation excludes the whole upcoming queue.
No duration-fit, genre, age or franchise rule is introduced.

Reconstruction includes starts above the growth target and survives restart via
existing history. Existing history whose source is absent from the current catalog
is omitted with a warning. Program deletion cascades to history, so those removed
rows cease contributing without a warning. Filler-list deletion instead clears the
filler marker: surviving rows are indistinguishable from main-program starts and
can contribute. This inherited classification limitation is not repaired here.
Editing seeds/settings or changing history/catalog can change the reconstructed profile. Preview does not write it.
Metadata and original semantic modes retain their prior scoring. Optional
`discovery` values persist in growth JSON and the existing dialog; no separate
Explore preset or adaptation-rate control is introduced.
