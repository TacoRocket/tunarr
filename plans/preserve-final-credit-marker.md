# Preserve Plex final-credit metadata

Plex's `Marker.final` was accepted by the Plex response schema but discarded
when a credits marker became an outro chapter. Preserve that source information
through conversion, storage, and the existing chapter API.

## Bounded behavior

- A credits marker's `final: true` becomes chapter `isFinal: true`.
- An explicit `final: false` remains `false`.
- Omitted flags and existing database rows remain unknown (`null` in storage).
- Intro and ordinary chapter conversion do not infer final-credit status.
- Playback, scheduling, episode duration, and stream selection remain unchanged.

The nullable `program_chapter.is_final` column is populated when chapter metadata
is imported or refreshed from the source. This migration does not rescan the
library or classify old chapters. The flag records Plex's assessment; it is not
an independent guarantee that a video has no later scene.

## Implementation

`PlexApiClient` carries the flag into `MediaChapter`; `ProgramDaoMinter` retains
it when creating database chapters. The existing Drizzle chapter writer and
`ProgramConverter` preserve it without special handling. Chapter insert types
use the Drizzle model, matching the existing writer's boolean representation.
The Kysely table type remains available for its separate database interface.

The generated migration adds one nullable column. The shared schema and
generated API chapter definitions accept a boolean, null, or an absent field,
so callers do not need to supply it.

## Validation and contribution boundary

The regression exercise covers an intro and three credits markers: explicitly
false, omitted, and true, through Plex conversion and chapter minting. Local
storage validation checks the generated SQL against an existing row and verifies
Drizzle reads null, true, and false distinctly. Fresh database migration,
typechecking, and changed-file linting are also checked.

This is a fork-only metadata change. Credit skipping, credit shrinking, overlays,
and schedule renewal are out of scope. No live deployment or additional upstream
PR is included. An upstream proposal must follow the project's schema/API design
approval process after the current contribution has been handled.

API generation exposed older unrecorded pod API changes. Only the new chapter
field is retained in this patch's generated definitions; unrelated generated
changes are excluded.
