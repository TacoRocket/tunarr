# Ordered after-show pods

The program-count path in `RandomSlotsService` materializes an ordered post-program recipe into the generated lineup. `postProgramPod` contains positions; each position supplies one or more `fillerListIds`. Selection chooses one list per position, then one complete clip from that list. Array order is playback order. The complete break contributes to `PaddedProgram.totalDuration` before the next program is placed.

No position has a fixed commercial, promo or closer role. The supplied recipe must have at least one position; omit `postProgramPod` to retain legacy post-filler behavior. Selections are made when the schedule is generated or regenerated, then saved in the ordinary lineup. Playback does not draw a new selection for each airing.

This is schedule-time materialization, using the existing uniform shuffle-bag iterators in `ProgramIterator` and `slotSchedulerUtil`. Repeated positions using the same list reuse its iterator. No new rotation algorithm, background controller or timeline service is involved. Pool exhaustion is an implementation policy of the existing iterator, not an editorial exposure requirement.

`CommonSlots.ts` owns the recipe contract, `SlotSchedulerHelper` resolves its pool references, and `SlotImpl.selectPostProgramPod` selects the clips. A recipe replaces the legacy single post-program selection; existing head, pre and tail filler retain their meanings. Without a recipe, scheduling behavior is unchanged. When an existing mid-roll configuration splits a program, its pod stays after the final segment.

Only program-count slots support pods. Fixed-duration and time-slot schedules reject them rather than fitting, trimming or dropping configured positions. Missing pools fail existing reference validation; a selected pool with no playable whole clip fails generation. Clips retain their full catalog durations. Generation produces an ordinary saved lineup, with the existing playback and guide behavior. This change adds no UI, database migration or live deployment automation.
