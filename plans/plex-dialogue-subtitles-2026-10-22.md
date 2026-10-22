# Plex dialogue subtitle selection (private fork)

Plex imports now preserve a nonempty source stream title, with displayTitle as the fallback. This restores distinctions such as Saban English Dub versus Original Japanese Audio and English Signs versus English Subs. Imports also retain the forced flag in program media streams. Existing imported rows require a metadata refresh to acquire these values.

The existing subtitle by_language API action accepts optional titleContains and excludeTitleContains, nonempty trimmed strings matched case-insensitively against the stream title. The first requires a match; the second rejects a matching title. For example, excludeTitleContains="sign" distinguishes English from English (Signs) in the observed Dragon Ball Kai inventory. A missing title does not match an exclusion; exclusion alone cannot establish full-dialogue availability. Example:

```json
{"type":"by_language","languages":["eng"],"titleContains":"English Subs","filterType":"any","allowImageBased":true,"allowExternal":true}
```

Language, forced/default filters, external/image permissions, and extraction availability still apply. Omitting both title filters preserves existing selection. A missing title cannot satisfy the constraint; no match returns no subtitle under the existing evaluator semantics. This does not infer dialogue from names, repair language labels, or add a UI control.

Embedded titles are stored in program_media_stream and passed through ProgramStreamDetailsFetcher. External subtitles are imported with titles, but playback uses program_subtitles, which has no title column: they cannot satisfy a positive titleContains constraint; exclusion-only rules do not reject them on title. Existing unconstrained external subtitle selection remains available. No migration or ambiguous join was added.

Create and update APIs validate the same shared rule schema and store the rules as JSON, preserving both optional fields. This change targets the demonstrated embedded anime tracks; live playback and channel policy validation are separate deployment checks.

Validation: four focused server test files passed (111 tests), covering Plex title conversion, forced-flag minting, embedded title passthrough, and dialogue selection after signs. Types build, server typecheck, lint-changed, and diff whitespace checks passed under Node 22.20.0. Direct schema parsing confirmed create/update retain both trimmed constraints and reject blanks. No live channel or media was changed by this implementation.
