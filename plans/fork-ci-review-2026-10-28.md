# Fork CI review — 2026-10-28

Status: operator approved the two-workflow reduction and restoration only when an upstream gap warrants it. Implementation removes the eight workflows and their two owned scripts, narrows Build to ready PRs/manual validation, and aligns active guidance. Existing tests and publication recipe are preserved. Focused validation and independent review are recorded in the implementation PR. Actions remains paused; no repository setting, branch rule or deployment was changed.

## Recommendation

Keep two workflows: validation of the combined fork source and manual publication
of its Linux amd64 container. Remove the eight inherited workflows that operate
upstream's contributor, documentation, translation, and multiplatform release
processes. Delete retired workflow-only scripts; do not leave inert duplicate
implementations. Keep existing local build tools, tests, and commit-message hooks.

Upstream owns validation and distribution of its unchanged release. We own the
combined source after integrating our patches, our custom FFmpeg runtime, and the
container we publish. Upstream passing does not validate our modified source.

## Evidence and scope

- Public fork main: `cf656e009f5555eb007d521a23f8bf5c1d97821d`.
- Local inspected source: `3f59667c533b3937d8ad8cdbc82dfa03b7c6a76f`;
  GitHub comparison confirms its file tree matches main.
- Adopted upstream v2026.10.4: `3a7a24d4496ecda08a8f6e234ac5f33eb38e43d7`.
- Nine of ten workflow files are byte-for-byte inherited from that upstream
  revision. Only container publication was adapted for the fork.
- Current fork differs in 114 files under server/types/web: 100 server, 10 types,
  four web. Broadly discarding existing tests would discard integration evidence.
- API history: 149 workflow runs from October 21–27; 54 on October 27.
- All 30 PRs returned by the fork API were authored by TacoRocket; none open.
- Branch protection read returned "Branch not protected"; repository rulesets
  returned an empty list. The approved-label merge rule is documented operator
  discipline, not an enforced GitHub branch gate.
- No GitHub Releases returned. Pages API returned 404 despite admin access;
  no configured Pages site was established by this audit. Docs workflow still
  writes a gh-pages branch. mkdocs.yml names the upstream repository/tunarr.com.
- Review covers TacoRocket/tunarr CI and its direct FFmpeg publication dependency;
  it is not an audit of every repository in the account.

## Workflow disposition

| Workflow                     | Runs | Proposed disposition          | Reason and consequence                                                                                                                                                                                                                                                            |
| ---------------------------- | ---: | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main.yml — Build             |   14 | Keep; narrow triggers         | Runs the combined source's generated API/client check, server/web typechecks, and existing tests including browser stories. Upstream cannot establish these for our changes.                                                                                                      |
| build-and-push-docker.yml    |    2 | Keep manual                   | Only supported fork distribution is Linux amd64 with our matching FFmpeg. Keep immutable inputs, cache, filter/startup checks and explicit publication.                                                                                                                           |
| pr-policy.yml                |   91 | Remove                        | Implements upstream contribution intake: design rules, AI disclosure, open-PR limits, labels, drafting and expiry. It exempts CODEOWNERS after starting a runner. It does not enforce our approved review label. Manual contribution review and approved-label discipline remain. |
| commitlint.yml               |   38 | Remove hosted workflow        | Existing .husky/commit-msg and scripts/preflight.sh already check commit messages. Keep them. External contributions need maintainer review; there will no longer be a hosted enforcement check.                                                                                  |
| docs.yml                     |    3 | Remove                        | Rebuilds/pushes the inherited upstream docs site. Link to upstream docs; keep fork additions in README/wiki/repository Markdown. This does not remove docs source or API generation checks.                                                                                       |
| lingui-extract.yml           |    1 | Remove post-merge auto-commit | web/turbo.json already runs extract-messages before bundle. Keep that build step and upstream catalogs. New fork text still needs translation work if translations are desired; extraction does not translate it.                                                                 |
| build-and-release-binary.yml |    0 | Remove                        | Produces five targets: Linux x64/ARM64, Windows x64, macOS x64/ARM64, including upstream signing/notary assumptions. The fork has no advertised native binary distribution. Upstream binaries remain upstream-only and lack our features.                                         |
| release.yml                  |    0 | Remove                        | Upstream CalVer/tag generation conflicts with our upstream-version-plus-fork-suffix release inputs. Its comment also claims Docker publication is tag-triggered, while our workflow is manual-only.                                                                               |
| release-comment.yml          |    0 | Remove                        | Upstream release comments/issue closing are not our container release process. Its script skips every hyphenated tag, including stable fork-style names. No hosted release announcements are promised in its place.                                                               |
| stale.yml                    |    0 | Remove                        | Daily issue/PR expiry is unnecessary for the current maintainer-operated fork. Leave closure decisions with the maintainer.                                                                                                                                                       |

The eight proposed removals account for **133 of 149 historical workflow runs
(89%)**. This is a historical run-count comparison, not a CPU/minute/billing
savings estimate or proof of the GitHub pause's exact trigger. Many policy runs
were short. Four removed workflows have not run and represent avoided future
work/maintenance rather than past compute savings.

## Narrow the retained validation workflow

1. Run on ready PRs to main and subsequent code updates; provide manual execution
   for a release revision or exceptional direct push. Skip draft runs and include
   ready_for_review so making a draft ready actually triggers validation.
2. Stop the routine push-to-main/dev/media-scanner run. Nine historical Build runs
   were PR events and five were pushes; a PR check followed by a merge currently
   causes another full check. Do not treat those five as proven redundant under
   every circumstance: the base may move or a direct push may bypass review.
3. Retain PR-only merge discipline, current-base validation before merge, and a
   check of the exact selected release source before publication. If direct main
   pushes remain an accepted workflow, keep main-push validation instead. This is
   the operator tradeoff; do not silently weaken validation on an unprotected main.
4. Skip documentation-only edits with narrow exclusions for prose/assets. Do not
   blanket-ignore docs/\*\*: docs/generated participates in the API consistency
   check. Code, shared contracts, generated API/client files, dependency files,
   compiler/build configuration and validation workflow changes must still run.
5. Cancel an older in-progress PR validation when a newer commit supersedes it,
   using GitHub's native per-PR concurrency. Do not cancel publication mid-push.
6. Reuse the existing validation commands and test suite initially. Do not invent
   a changed-test selector or delete upstream tests just to lower run counts:
   unchanged tests can detect regressions introduced by fork code.

GitHub documents PR validation's merge-ref behavior and concurrency cancellation:
[PR events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Publication: retain ownership, avoid overstating waste

The public image contains custom NV12 and VAAPI LUT runtime behavior. Replacing
that runtime with upstream merely to avoid building it would lose fork behavior.
Keep the current manual publication recipe and its cache in the initial cleanup.

The recipe always invokes the FFmpeg build job, even for app-only releases.
However, the successful publication's FFmpeg job lasted 32 seconds, followed by
6m07s for Tunarr: the cache already substantially reduced repeated work. It would
be inaccurate to call that a full FFmpeg recompile on every release.

An additional bounded improvement is to pin/reuse an already published matching
runtime digest when FFmpeg source, dependencies, build options and recipe are
unchanged, rebuilding only when those inputs change or an explicit runtime
refresh is intended. That changes the publication input contract and should be
decided separately from deleting unused inherited workflows. The FLAC release
kept ffmpegCommit fd620cfb but introduced a new runtime tag; changing only Tunarr
does not by itself require a new runtime build. Do not infer matching inputs from
the FFmpeg source revision alone.

## Evidence links and limits

- [Fork workflow sources at reviewed main](https://github.com/TacoRocket/tunarr/tree/cf656e009f5555eb007d521a23f8bf5c1d97821d/.github/workflows)
- [PR29 policy run](https://github.com/TacoRocket/tunarr/actions/runs/40597527692): log says
  `Skipping: TacoRocket is a bot or listed in CODEOWNERS.` This verifies the
  current exemption; it does not prove all earlier policy runs skipped.
- [Successful fork publication](https://github.com/TacoRocket/tunarr/actions/runs/40460893717).
- [Upstream Build for adopted source](https://github.com/chrisbenincasa/tunarr/actions/runs/40208984118): success.
- [Upstream Docker publication](https://github.com/chrisbenincasa/tunarr/actions/runs/40226035442): success.
- Upstream binary publication runs at the adopted revision included failures;
  "rely on upstream" is an ownership decision, not a claim every upstream artifact
  exists or passed. Our README already identifies native downloads as upstream.
- GPU playback, live configuration preservation and IPTV-client acceptance remain
  deployment checks; hosted CI does not replace them.

## Proposed implementation after agreement

One bounded cleanup: delete the eight retired workflows and the two exclusively
owned scripts (.github/scripts/pr-policy.cjs and release-comment.sh), narrow
main.yml triggers/concurrency, and align active fork guidance with the retained
manual review and release process. Keep local commitlint tooling, language
catalogs, build tools and existing tests. Do not add a replacement policy bot,
scheduled job, matrix or CI system. When upstream is integrated again, review
workflow additions rather than automatically restoring these retired processes.

The operator approved this reduction after the review. Workflow changes proceed through the fork's PR review process. Re-enabling Actions remains with the operator; runtime digest reuse is deferred. The audit above retains the observed pre-change counts and rationale.
