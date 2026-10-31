# Fork container

The combined image includes our Tunarr source and matching FFmpeg/libplacebo runtime. Linux x86-64 is the initial target. Version `2026.10.4-fork.1` is [publicly available](https://github.com/TacoRocket/tunarr/pkgs/container/tunarr), and a complete pull with an empty Docker credentials configuration succeeded. Later versions are named `<upstream version>-trfork.<N>`; see [Release cadence](#release-cadence).

## Runtime

New containers built with the current recipe run Tunarr on **Bun**. Older
published images keep their original runtime. The fork container supports
Linux x86-64 (`linux/amd64`).

## Matching UI and backend versions

Build the UI and backend from the same checkout with the same `TUNARR_VERSION`,
`TUNARR_BUILD`, and `TUNARR_EDGE_BUILD` settings. Use the container recipe; do not
reuse web assets from a previous candidate. The packaging step compares the web
build's `version.json` with the bundled backend's `--version` output and refuses
missing or mismatched metadata. Rebuild both bundles to correct a mismatch; do
not edit the version file to relabel older assets.

The backend prefers version settings embedded during bundling, with runtime
environment settings as a fallback. This check compares the web stamp with the
built backend's reported version in the packaging environment; a custom image
that skips this step must still pass the served-version check below.

Before publishing or switching to a newly built candidate, check the versions
served by that candidate as well:

```sh
candidate_url=http://127.0.0.1:8000
curl --fail --silent --show-error "$candidate_url/api/version" > /tmp/tunarr-api-version.json
curl --fail --silent --show-error "$candidate_url/web/version.json" > /tmp/tunarr-web-version.json
jq -e -s '.[0].tunarr as $backend | ($backend | type == "string" and length > 0) and .[1].version == $backend' /tmp/tunarr-api-version.json /tmp/tunarr-web-version.json
```

The publication workflow checks both against the intended release version before
pushing the image. A release pinned to source from before `version.json` existed
is checked against the version stamped into its web bundle instead. Older images without `web/version.json` need a fresh build.
This checks version consistency; matching labels alone do not establish source
identity or API compatibility. Keep recording the source revision separately.

## Hardware and picture options

The basic Compose example starts without GPU access. On a Linux host with a VAAPI device, add this to the `tunarr` service, then select VAAPI and the appropriate render device in Tunarr's transcode profile:

```yaml
devices:
  - /dev/dri:/dev/dri
```

The image includes the optional filters, but does not enable hardware-specific trials globally. Add only the options you want to the service's existing `environment` list:

```yaml
# Optional driver-default scaling instead of the usual HQ scaling request.
- TUNARR_VAAPI_DEFAULT_SCALING=1

# Optional direct NV12 output for eligible Broadcast shader paths.
# This Native mode has only been validated with Intel ANV.
- TUNARR_CRT_DIRECT_NV12=1
- ETV_VAAPI_DIRECT_NV12=1
- TUNARR_CRT_NV12_OUTPUT=native

# Optional fixed-Hable VAAPI HDR conversion; leave unset to retain OpenCL.
- TUNARR_VAAPI_HABLE_LUT=1
```

Direct output does not remove shader work: shaders still use the programmable GPU, and encoding can use the dedicated video encoder. It avoids an intermediate conversion on eligible paths. Native mode is not a general cross-driver default. The fixed-Hable option handles eligible HDR10 material, lacks OpenCL's scene adaptation, and is not an exact picture match. Only Intel Gen12 has been exercised for that option. Unsupported hardware may fail; remove the corresponding option to restore the previous route.

Picture styles are channel settings, separate from these runtime options. See [CRT looks](crt.md) for picture controls and the [transcoding settings reference](transcoding.md) for scaling and HDR limits. Ad pods are covered in [Scheduling](scheduling.md#after-show-ad-pods).

## Publication status

[The successful run](https://github.com/TacoRocket/tunarr/actions/runs/40460893717) built both components, passed the optional-filter and fresh-config checks, and published the application. An anonymous Linux amd64 pull returned the same digest as the publication log:

```text
ghcr.io/tacorocket/tunarr@sha256:6b9fbe9e16230a4eb207e7dcdd646ae24418a2b9b745cec24005dff3fcd0574b
```

The publication recipe is commit `b0fd00ad4f8ffd9495b99b5dd7fab121d554b701`. [Attempt 1](https://github.com/TacoRocket/tunarr/actions/runs/40459059909) built both images but stopped before the application push when its readiness check did not retry a startup connection reset. The corrected check retried the resets and passed once the server was listening. No application code or source inputs changed between attempts.

## What this first release proves

The application and FFmpeg source revisions come from our tested custom setup. This public image is assembled afresh from those public sources, without private configuration, media, or the deployment's local compatibility wrapper. It is not a copy of a running installation. The workflow checks FFmpeg's software encode/probe capabilities, optional filter presence, and Tunarr startup with an empty configuration before publishing the application image. Hosted runners do not establish GPU playback or IPTV-client acceptance for this new assembly.

Keep versioned images and a matching configuration backup for rollback. Reverting an image alone does not undo database migrations. This first release does not publish a moving `latest` tag or deploy anything automatically.

CRT processing defaults to Quality even with these runtime flags. Select
Performance to use eligible hardware optimizations or Experimental to try
additional shortcuts that can slightly change the picture. See
[processing tiers](crt.md#processing-tiers).

## Source and maintenance

- Tunarr: [`a89f146c`](https://github.com/TacoRocket/tunarr/commit/a89f146c4424e3988bacc56f2f7074ca62b63f77) on `release/trfork.9`: [`c30d061e`](https://github.com/TacoRocket/tunarr/commit/c30d061ef8a560b2273ba0232368060a58ec6924) plus #87 (Meilisearch 1.52.4), based on upstream 2026.10.4 with our integrated changes.
- FFmpeg build and patches: [`a64ee856`](https://github.com/TacoRocket/ErsatzTV-ffmpeg/commit/a64ee8563c35e4633aa221597b7d70f87d5e1562), synced with upstream ErsatzTV-ffmpeg 8.1.2-7, using FFmpeg 8.1.2 and the dependency image pinned in that revision.
- [Release inputs](../../docker/fork-release.json) identify the two source revisions and image version. `main` contains the latest reviewed, integrated fork source; the release inputs continue to identify the exact source used for the published image.

The manual [publication workflow](../../.github/workflows/build-and-push-docker.yml) builds the optional NV12 and VAAPI LUT components through the existing FFmpeg recipe, then uses that runtime's registry digest as the Tunarr base. It publishes only to this fork's GitHub container registry. New source combinations get new version tags after review. Reuse the existing recipes; avoid another independent build system.

For a new package, check its visibility in GitHub Packages and verify a complete pull without credentials before advertising it as available. The first `tunarr` package is public and passed that check. Users only need the combined `tunarr` image; the workflow manages the `tunarr-ffmpeg` intermediate.

Upstream improvements should replace our equivalent patches when adopted. Feature branches remain development checkpoints, not separate supported distributions. Use the [publication PR](https://github.com/TacoRocket/tunarr/pull/25) for first-release feedback and pull requests for code contributions; broader upstream changes are discussed with the relevant maintainer first.

### CI and release checks

To publish the Bun recipe, first merge it, update `tunarrCommit` in
`docker/fork-release.json` to a reviewed commit containing it, and choose a new
release version. The publication check verifies the pinned Bun version and
entrypoint, opens SQLite, starts Tunarr, and requires a valid FFmpeg version from
its API before pushing the image. An old source pin is rejected. Merging this
recipe alone does not publish or deploy an image.

The fork keeps two workflows: **Build** and **Publish fork container**. Build runs the existing API/client consistency checks, typechecks and tests for ready PRs to `main`. Drafts and changes limited to Markdown or documentation images do not run it; generated API files still do. A newer commit cancels the older PR validation. There is no second automatic run after merge.

Use PRs and validate against the current base before merging. The `approved` review label remains required by our maintainer process; GitHub branch protection is not configured. An exceptional direct push needs a manual Build run.

Before publishing, run **Build** manually and set its `ref` input to the exact `tunarrCommit` in `docker/fork-release.json`. Confirm that source passed, then run **Publish fork container** from the reviewed release recipe. Publication still checks the matching runtime and fresh-config startup. Neither workflow proves GPU or IPTV-client playback.

Build caches successful shared, web unit/Storybook, and the full server test results. Package source, tests, fixtures and configuration, dependency hashes, prerequisite builds, root TypeScript/toolchain configuration, and the CI Node version and runner image are cache inputs. An unchanged suite reuses its previous result; a changed input runs it again. The Playwright version in the lockfile selects the Chromium revision used by Storybook. The cache archive key uses the actual checked-out commit, including when a manual Build selects a different `ref`.

Server latency and heap regression checks (`tests/perf/`) stay in the same server suite and share its cache. Local FFmpeg/hardware tests, worker smoke checks, E2E tests and container publication checks are not covered by cached test results. To deliberately re-execute cached suites, use Turbo's `--force` option.

A suite runs when there is no compatible cached result. PR-created caches are scoped to that PR, but PRs can also restore compatible caches from `main`, so a new PR's first run is not necessarily cold. After merging toolchain or dependency updates, a manual Build on `main` refreshes the cache available to other PRs; merging alone does not do that.

Upstream owns its documentation site, translation catalogs and native platform releases. Our image build still extracts translation messages, and fork translations can be submitted explicitly. Commit-message hooks and local preflight remain available. Contribution-policy review, issue closure and release announcements are manual. Retired workflows can be restored when a concrete fork need appears; upstream merges should not reintroduce them automatically.

### Release cadence

We follow upstream Tunarr's stable releases rather than a separate calendar. For each update, we integrate the upstream release with our remaining fixes, check the combined build, and publish a versioned fork image. Fixes already adopted upstream are removed from our patch set.

Published versions are named after the upstream release they build on, then `trfork` and a number: `2026.10.4-trfork.2` is upstream Tunarr 2026.10.4 with our second published patch set. The `trfork` marker tells anyone who reads a version in Tunarr's Help menu, a log or a bug report that it is the TacoRocket fork, not an upstream build. The number starts at 1 for each upstream release and is never reused for a changed build; counting on 2026.10.4 continues from the first image, `2026.10.4-fork.1`, which predates this rule and keeps its name. The FFmpeg runtime image follows the same pattern from its FFmpeg version, such as `8.1.2-trfork.1`. The publish workflow refuses any other name.

Candidates are built and tested on our own server under working names and are not published. After build checks, copied-configuration checks and playback acceptance, the accepted source combination is published under its `trfork` version. Each published version records its Tunarr and FFmpeg revisions. An upstream release starts the update process, not an automatic deployment or a same-day release promise.

You can pull `main` for newer reviewed source between releases. Use a versioned container for a tested package. Public main history stays intact: upstream changes are merged through an integration PR, without force-rebasing the branch people already use. Publication remains a manual action through the existing workflow.

### Search engine upgrades

Meilisearch is a critical dependency, like the FFmpeg build, so we keep it current in small hops of about three months of Meilisearch releases rather than one large jump. The version is pinned in `server/package.json` (`meilisearch.version`); the image, binary and macOS builds all download that version. Skip releases with known regressions: Meilisearch 1.40 through 1.52.3 use a memory allocator that can crash or leak threads under load, so the hop after 1.39 goes straight to 1.52.4. Treat a change to the startup flags Tunarr passes as its own hop. Since 1.52.4, Tunarr starts Meilisearch with `--upgrade-db` (called `--experimental-dumpless-upgrade` before Meilisearch 1.51), and Meilisearch on each side of 1.51 refuses the other name. Ship the pinned Meilisearch binary with its matching Tunarr build, and roll them back together. If you point Tunarr at your own Meilisearch with `TUNARR_MEILISEARCH_PATH`, the flag needs 1.51 or newer. The version this hop was checked with is 1.52.4, which also avoids the allocator bug.

**An upgrade is one-way.** On first start, the new Meilisearch upgrades the search index in place, and the previous version then refuses to open it, reporting that the database version is incompatible with (or newer than) its own. The snapshot in `ms-snapshots/` is rewritten in the new format at the next scheduled snapshot: every 4 hours by default, counted from when Tunarr starts, so a restart starts that clock over. Treat the old snapshot as gone soon after the upgrade. Rolling the image back alone therefore leaves search broken.

Before deploying a new Meilisearch version, stop Tunarr and copy both folders from Tunarr's data folder:

```bash
cp -a data.ms data.ms.pre-<old version>
cp -a ms-snapshots ms-snapshots.pre-<old version>
```

The copies also cover an upgrade that stops partway, since Meilisearch's in-place upgrade isn't atomic.

To roll back, stop Tunarr, move the upgraded `data.ms` and `ms-snapshots` aside, move the two copies back into place, and start the previous image. Search then holds the library as it was when the copies were made.

**A normal library scan does not fill that gap.** Scans skip items whose metadata hasn't changed before they reach the search index, so anything added or changed since the copy can stay missing from search. To bring search fully up to date, run a forced scan of each media source:

```bash
curl -X POST "http://<tunarr host>:8000/api/media-sources/<media source id>/libraries/all/scan?forceScan=true"
```

Run them one media source at a time: a library accepts one scan at a time, and the request returns as soon as the scan is queued. A forced scan re-reads every item from the media server and can take hours on a large library.

Without the copies, move both folders aside and start the previous image. Tunarr starts with an empty search index, and the same forced scans rebuild it.

Either way, channels, lineups and library records are untouched, because they live in Tunarr's database. Until the forced scans finish, though, search results are incomplete, and so is anything built from them: smart collections, and filler lists synced from smart collections. Check a few of those before relying on them, and re-sync smart filler lists once the scans are done.

Keep the copies until the new version has run through a few daily scans.
