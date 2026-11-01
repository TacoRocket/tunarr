#!/usr/bin/env bash
# Prints the body of the "Upstream watch" issue: how far each fork we ship is
# behind the project it follows, and which pinned upstream releases are newer
# than ours. Run from the repository root; reads the pins from this checkout.
#
# Each check fails on its own: a row the API cannot answer says so, and the
# rest of the report still prints.
set -uo pipefail

FORK=${FORK_REPO:-TacoRocket/tunarr}
UPSTREAM=chrisbenincasa/tunarr
NEXT_FORK=TacoRocket/next
NEXT_UPSTREAM=ErsatzTV/next
FFMPEG_FORK=TacoRocket/ErsatzTV-ffmpeg
FFMPEG_UPSTREAM=ErsatzTV/ErsatzTV-ffmpeg

unknown='could not check'

# Commits `head` has that `base` does not, compared inside `repo`.
ahead() {
  local result
  if result=$(gh api "repos/$1/compare/$2...$3" --jq '.ahead_by' 2> /dev/null); then
    printf '%s\n' "$result"
  else
    echo "$unknown"
  fi
}

latest_release() {
  local result
  if result=$(gh api "repos/$1/releases/latest" --jq '"\(.tag_name) (\(.published_at[0:10]))"' 2> /dev/null); then
    printf '%s\n' "$result"
  else
    echo "$unknown"
  fi
}

commits() {
  case $1 in
    "$unknown") echo "$unknown" ;;
    1) echo '1 commit' ;;
    *) echo "$1 commits" ;;
  esac
}

fork_version=$(jq -r '.version // empty' docker/fork-release.json 2> /dev/null)
ffmpeg_pin=$(jq -r '.ffmpegCommit // empty' docker/fork-release.json 2> /dev/null)
next_pin=$(jq -r '.ersatztvNext.releaseTag // empty' server/package.json 2> /dev/null)
upstream_next_pin=$(gh api "repos/$UPSTREAM/contents/server/package.json" --jq '.content' 2> /dev/null |
  base64 -d 2> /dev/null | jq -r '.ersatztvNext.releaseTag // empty' 2> /dev/null)

tunarr_behind=$(ahead "$FORK" main "${UPSTREAM%%/*}:${UPSTREAM##*/}:main")
if [ -n "$ffmpeg_pin" ]; then
  ffmpeg_behind=$(ahead "$FFMPEG_FORK" "$ffmpeg_pin" "${FFMPEG_UPSTREAM%%/*}:${FFMPEG_UPSTREAM##*/}:main")
else
  ffmpeg_behind=$unknown
fi

cat << EOF
Updated $(date -u +%Y-%m-%d) by the weekly **Upstream watch** workflow. "Behind" counts commits the upstream has that ours doesn't. When a number climbs or a newer release appears, it's time to sync.

| What | Ours | Upstream | Behind |
|---|---|---|---|
| Tunarr source | \`$FORK\` \`main\` | \`$UPSTREAM\` \`main\` | $(commits "$tunarr_behind") |
| Tunarr release | built on ${fork_version:-unknown} | latest $(latest_release "$UPSTREAM") | |
| ErsatzTV next worker | ${next_pin:-not bundled yet} | upstream Tunarr pins ${upstream_next_pin:-none}; latest $(latest_release "$NEXT_UPSTREAM") | |
| FFmpeg runtime | \`$FFMPEG_FORK\` at \`${ffmpeg_pin:0:8}\` | \`$FFMPEG_UPSTREAM\` \`main\`; latest $(latest_release "$FFMPEG_UPSTREAM") | $(commits "$ffmpeg_behind") |
EOF

branches=$(gh api "repos/$NEXT_FORK/branches" --paginate --jq '.[].name' 2> /dev/null)
if [ -z "$branches" ]; then
  echo "| \`$NEXT_FORK\` | branches | \`$NEXT_UPSTREAM\` \`main\` | $unknown |"
fi
for branch in $branches; do
  behind=$(ahead "$NEXT_FORK" "$branch" "${NEXT_UPSTREAM%%/*}:${NEXT_UPSTREAM##*/}:main")
  echo "| \`$NEXT_FORK\` | \`$branch\` | \`$NEXT_UPSTREAM\` \`main\` | $(commits "$behind") |"
done

if [ "$tunarr_behind" != "$unknown" ] && [ "$tunarr_behind" -gt 0 ]; then
  printf '\n### Newest upstream Tunarr commits we do not have\n\n'
  # shellcheck disable=SC2016 # jq expressions, not shell
  gh api "repos/$FORK/compare/main...${UPSTREAM%%/*}:${UPSTREAM##*/}:main" \
    --jq '.commits | reverse | .[0:10][] | "- \(.commit.message | split("\n")[0]) (`\(.sha[0:8])`)"' 2> /dev/null ||
    echo "$unknown"
fi
