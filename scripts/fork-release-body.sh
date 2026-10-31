#!/usr/bin/env bash
# Prints the GitHub Release body for a published fork image: the hand-written
# notes, then the install line, the source revisions and (optionally) the full
# list of merged PRs.
#
# Usage: scripts/fork-release-body.sh <notes.md> <image digest> [changes.md]
#
# Version and revisions come from docker/fork-release.json, or from the file
# named by RELEASE_INPUTS (used to backfill releases for older images).
set -euo pipefail

notes=$1
digest=$2
changes=${3:-}
inputs=${RELEASE_INPUTS:-docker/fork-release.json}

version=$(jq -er .version "$inputs")
tunarr=$(jq -er .tunarrCommit "$inputs")
ffmpeg=$(jq -er .ffmpegCommit "$inputs")
ffmpeg_tag=$(jq -er .ffmpegTag "$inputs")

if [ "$(head -n 1 "$notes")" != "# $version" ]; then
  echo "$notes must start with '# $version'" >&2
  exit 1
fi
if [[ ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "image digest must look like sha256:<64 hex digits>, got '$digest'" >&2
  exit 1
fi

# The release title already names the version, so drop the heading line.
tail -n +2 "$notes" | sed -e '/./,$!d'

cat <<EOF

## Install

\`\`\`yaml
image: ghcr.io/tacorocket/tunarr:$version
\`\`\`

Exact image: \`ghcr.io/tacorocket/tunarr@$digest\`

Keep a backup of your Tunarr data folder before upgrading. Going back to an older image does not undo database or search-index changes.

## What's inside

- Tunarr source: [\`${tunarr:0:8}\`](https://github.com/TacoRocket/tunarr/commit/$tunarr)
- FFmpeg runtime: \`ghcr.io/tacorocket/tunarr-ffmpeg:$ffmpeg_tag\`, built from [ErsatzTV-ffmpeg \`${ffmpeg:0:8}\`](https://github.com/TacoRocket/ErsatzTV-ffmpeg/commit/$ffmpeg)
EOF

if [ -n "$changes" ] && [ -s "$changes" ]; then
  # GitHub's generated list: PR lines, then a "Full Changelog" compare link.
  # A release whose source was cherry-picked can have no PR lines at all.
  if grep -q '^\* ' "$changes"; then
    printf '\n<details>\n<summary>Every merged pull request</summary>\n\n'
    cat "$changes"
    printf '\n</details>\n'
  else
    printf '\n'
    cat "$changes"
  fi
fi
