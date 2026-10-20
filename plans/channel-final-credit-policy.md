# Optional final-credit advance

On channels with `advanceAtFinalCredits: true`, finish main programming at the start of its single valid `outro` marker carrying `isFinal: true`, then play the existing next lineup item. This is a channel playback endpoint, not a change to source files or catalog durations.

## Contract

- `POST /api/channels` / `PUT /api/channels/:id` accept the optional boolean. New channels default off. Omitting it on update preserves the stored choice. Reads return the stored value.
- `POST /api/programming/generate-block` accepts optional `channelId` to use that channel's policy. Omit it for existing full-program behavior. Generation does not save or place anything.
- Main program selection in classic time/random slots uses the same endpoint before fitting slots or placing breaks. Filler pools always retain full clip durations, including when the same file is also a main program.
- Manual lineup saves cap whole main items at the endpoint, preserving shorter explicit items and explicit start offsets. Scan-time reconciliation uses the policy instead of restoring full durations. Toggling the channel setting reconciles its saved lineup and guide; disabling restores full main program durations.
- Missing, false/unknown, ambiguous multiple-final, non-finite, reversed or out-of-file markers retain full-program behavior. The marker belongs to the first stored media version, matching current playback selection. No estimates or credit detection.
- Existing segment reconciliation applies the effective endpoint to scheduled mid-roll segments. This does not introduce new excerpt or mid-roll editing behavior.
- Playback and guide use the saved lineup lengths; no player-side jump timer. Existing fixed time slots may still insert their configured flex to preserve clock anchors. For sequential after-show programming, the next existing item starts at the final-credit boundary.

## Boundaries

API only. No UI, overlays, shrinking, automatic renewal, new promo selection, or upstream PR. Infinite schedules are not expanded by this change. Trial is one isolated channel/container; main channels remain on the existing build and policy until approval.

## Validation

Focused existing scheduling/reconciliation checks plus a direct cloned-database API and playback demonstration. Record actual results and untested modes after the demonstration.

## Demonstration result

The isolated candidate exercised one channel with a movie, a complete existing promo, and an episode without a known final marker. The opt-in movie endpoint was 6,488,854 ms instead of its catalog duration of 6,787,616 ms. FFmpeg's seek plus playback duration equaled that endpoint exactly; the following 15,093 ms promo ran whole. The guide's next-program start equaled the shortened movie plus the promo. A 120-second HLS capture showed the ending scene, promo, and next episode.

API exercises confirmed default-off migration, opt-in generation, legacy generation with no channel ID, manual apply, classic slot preview/save, scan-time duration reconciliation, omission-preserving settings updates, and disabling/restoring full duration. False, unknown, zero-start and out-of-file final markers retained full playback. The source catalog duration was unchanged.

The captured mixed-frame-rate HLS had timestamp warnings in both enabled and disabled baseline runs; no decoder-corruption messages appeared. This is not proof of seamless playback on every client. TiviMate and non-HLS modes were not exercised. The generic classic movie-slot preview also included promo-pool files as main selections through existing collection/mapping behavior; that separate issue is unchanged by this feature.

Validation: 165 existing checks passed across six focused files; types/shared/web builds, server/web typechecks, and changed-file lint passed. Existing test constructors were updated for the duration service dependency; no speculative test suite was added. API schemas and generated client bindings include the setting and the block-generation channel context. The web form only preserves the field during serialization; there is no new UI control.

The candidate was stopped after demonstration. Main deployment, settings, all 26 lineup hashes, and main schema remained unchanged. No upstream PR was opened. Older Plex entries without imported final flags continue playing in full; enabling a channel does not initiate a bulk metadata scan.
