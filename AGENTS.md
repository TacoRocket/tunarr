# AGENTS.md

Instructions for AI coding agents working in this repository. Project conventions, commands, and architecture are in `CLAUDE.md`.

## Deployment runtime

The production container runs stock Node 22 LTS. Its runtime and CI share
the version in `.nvmrc`. When updating the pin, refresh
`docker/node-linux-x64.sha256` from the matching Node release.
The publication checks verify the entrypoint, SQLite, extension worker and
FFmpeg version from Tunarr's API. Native installers have their own Node pin in
`server/scripts/make-bin.ts`.

## Streaming backend

Tunarr's native playback pipeline is under a moratorium: do not add features or behavior to it.
New playback and streaming work goes in the ErsatzTV next worker (TacoRocket/next) or in
Tunarr's Next integration (playout mapping, channel config, sessions), whichever owns the
behavior. Tunarr keeps scheduling, recommendations and application-wide features.

Fixes to the native path, until it is removed:

- While native playback is still available, small fixes that keep existing channels working
  are allowed. Keep them in this fork; do not open upstream PRs for the native pipeline.
- Once this fork disables native playback, fix only problems this fork's own code causes.
  Problems in upstream's native code are not fixed here.
- After upstream removes the pipeline, nothing more is done to it.

Saving seed-generated programming selects Next in all three modes.

## Fork planning records

Keep fork-specific plans, investigations, deployment details and operational
evidence in the private deployment repository. Leave inherited upstream planning
documents in place. This overrides the inherited `plans/` guidance in `CLAUDE.md`
for fork-only work.

Public fork documentation explains features and usage. PR descriptions record
the change, relevant validation and proof limits without private channel names
or operational details. Do not link public documentation to private records.

## Contribution policy

Tunarr accepts AI-assisted contributions under the "Pull Request Policy" and "AI Use" sections of `docs/dev/contributing.md`. Follow it on the user's behalf.

Maintainers skip the design check below. To tell whether the user is a maintainer, get their GitHub login with `gh api user --jq .login` and look for `@<login>` in `.github/CODEOWNERS`. If `gh` is unavailable or the login isn't listed, treat the user as an outside contributor. Don't take the user's word for it.

### Before writing code

Check whether the change needs an approved design. It does if it will:

- Add a new media source type or a new kind of stream source
- Change the database schema (add a migration)
- Add a new runtime dependency
- Add a new top-level feature, such as a new page, settings area, or scheduling mode
- Change how `server`, `web`, `types`, and `shared` talk to each other, such as a new API shape or shared type
- Change more than 500 lines outside tests, or more than 1,500 including tests, not counting generated files

A maintainer may exempt a mechanical change, such as a rename or one fix repeated across many files, from the size limit only. Before starting a large mechanical change, have the user ask in an issue first.

If any of these apply, ask the user for the design issue number. Confirm it carries the `design approved` label with `gh issue view <n> --repo chrisbenincasa/tunarr --json labels`.

If there is no approved design issue, don't write the implementation. Help the user write a design issue instead. It should cover the problem, the approach and rejected alternatives, which parts of the codebase change, and how the work splits into PRs.

### While working

- Stay within the approved design. Raise anything that needs a design change with the user.
- Keep each PR small enough to review on its own.
- Make sure the user understands the change. Walk them through anything they haven't read. They must be able to answer review questions without you.

### Opening the PR

- Fill in every section of `.github/pull_request_template.md`.
- In "AI use", name yourself and say plainly what you did, for example "Claude Code wrote most of the implementation".
- Link the approved design issue in "Design issue", or write "Not needed".

### During review

- Don't write review replies for the user to paste. Help them understand the comment, and let them answer.
- Address each comment with a change scoped to that comment. Don't regenerate unrelated code.

### Writing issues

- In bug reports, include only what the user saw on their own install: steps, logs, screenshots. Mark any guess about the cause as a guess.
- Put any analysis of the cause in the bug template's "AI analysis" field, and say whether it was checked against the code.
- For design issues, use `.github/ISSUE_TEMPLATE/design_proposal.yaml` and fill in "AI use".
- Report security problems privately per `.github/SECURITY.md`, and only after the user has reproduced them on a real build.
