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
