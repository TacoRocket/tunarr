# Request-owned degradation reports (#103)

Operator-approved outcome: report MPEG-TS and HLS Direct v1 transcode decisions
without mixing requests or changing playback. No deployment.

The invariant is that a report belongs to one active media request and one
session instance. Overlap cannot overwrite another request; delayed cleanup
cannot touch a replacement session. Reporting identifiers must not enter the
existing playback-token retry throttle.

## Mechanism

- Concat sessions already fan one producer out to several viewers. Carry their
  instance ID through internal playlists in a separate reporting parameter.
- Keep request reports on the owning Session, keyed by server-generated UUID.
  Include item identity, connection details, and optional degradations. Never
  infer a viewer from an IP address or user agent.
- Standalone requests have no existing playback session. Register a report-only
  session group in SessionManager's existing map, under a separate key. Include
  it in API reads but exclude it from playback lookups and on-demand decisions.
- Observe ProgramStream's transcode assignment and termination. Omit reasons
  while unknown or after that transcode ends; remove the request on output end,
  close, error, startup failure, or explicit stop. Clear reports at parent stop.
- Preserve each request's own firstSeen. Do not union overlapping reports into
  a session-level claim. Existing shared-HLS reporting remains unchanged.

## Validation and boundary

The current defect is the missing handoff from per-request ProgramStream to the
sessions API. Focused unit checks will exercise that handoff, overlapping
same-IP requests, resolved/unknown reports, parent replacement, and cleanup.
Verify reporting URL propagation separately from playback token propagation.
Run focused existing session checks, formatting, lint, and typecheck; regenerate
OpenAPI/client. Unit evidence does not claim TV-client or live playback acceptance.

No persistence, new dependency, viewer tracking across HLS refreshes, new runtime
failure detector, UI, playback-policy change, or deployment. #68 remains open.

## Checkpoint evidence

- The VideoStream handoff tests fail against the pre-change implementation
  because the report owner is never called. Restoring the fix passes both.
- 61 focused tests pass across request ownership, transcode observation, actual
  VideoStream handoff, generated playlist URLs, existing HLS sessions, and the
  existing on-demand task. These are unit checks with controlled collaborators.
- Same-IP requests serialize distinct IDs/items/reasons; one request's close
  leaves the other intact. Delayed requests cannot attach to a replacement.
- Startup failure, abort before/during setup, output end/close/error, and
  transcode replacement release or clear reports at their owning boundary.
- The calculator receives the unchanged playback token; internal URLs carry
  reportingSessionId separately. Standalone Direct v1 playlist URLs are unchanged.
- Server typecheck, dependency build, formatting and changed-file lint pass.
  OpenAPI and web client regenerated with the additive reporting contract.

## Clean-context review correction

Disposition: STAND, REBUILT. The request-owned design holds, but the review
identified a real gap: the route attached its disconnect listener after two
awaited lookups. Disconnecting during either lookup could miss the event and
create a report for a closed request. A focused handler unit check reproduced
that gap for both lookups and an already-destroyed response. The route now
attaches reporting cancellation before its first await and checks destroyed
state. Playback startup/stop policy is unchanged. The three checks pass after
this correction; no live HTTP server or integration suite was added.

Status: implemented; pending external review. No deployment.
