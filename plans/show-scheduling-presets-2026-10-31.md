# Show scheduling presets — #58

## Authorized scope

Provide Marathon, Primetime, Saturday Morning and Variety recipes through the
API. Reuse classic slots, episode ordering, linked iteration groups and
after-show pods. UI work is deferred until upstream's redesign lands. No
deployment or live channel edits are part of this change.

## Mechanism and boundary

`POST /api/programming/presets` expands the selected recipe into an ordinary
`RandomSlotSchedule`. It does not load media, generate a lineup or persist a
channel. The existing channel preview and programming APIs own those actions.

Show slots rotate in request order with 4, 2, 1 or 2 episodes respectively.
Variety alternates each show's pair with two shuffled items from one Custom
Show or Smart Collection. Its wildcard slots share an existing `continue`
iteration group so turns advance one shuffle. Show progression and wildcard
progression are independent. Optional `postProgramPod` uses the existing schema
and is attached to every content slot. Counts and other settings remain ordinary
editable schedule fields.

The inspected Colony Drop lineup had paired sequential episodes, wildcard
programs and intervening ads, but no saved slot recipe. This is a reusable recipe
for that pattern, not a reconstruction of its full lineup or current position.
Preset names describe rotation styles, not clock or weekday constraints.

## Focused verification

- Built shared types and typechecked the server and generated web client.
- Direct Fastify injection: all four preset responses passed the strict schedule
  schema; seven malformed requests returned 400. No database, channel context or
  worker pool was attached to the injected server.
- Ten bounded generations with copied Colony Drop metadata: all four recipes,
  ads on/off, and both wildcard source types. Checked rotation, sequential episode
  progression, shared wildcard shuffle, whole program durations, after-show ads
  and identical output when reusing the same returned recipe and seed.
- Existing scheduler, pod and group suites: 50 checks passed. Existing programming
  API suites: 5 checks passed.
- Regenerated OpenAPI and client. The only OpenAPI change is the new endpoint;
  existing definitions are unchanged. Ran changed-file lint and diff checks.

The copied-data exercise used the scheduler directly; it was not a live channel
save, media playback check or deployment. Generated client files expose the API
contract only; no UI component, page or model changes are included.
