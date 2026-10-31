# Toonami live relay — draft experiment

This draft lets an empty Tunarr channel play Toonami Aftermath's Eastern live
HLS feed. Tunarr opens the feed directly and transcodes it using the channel's
profile. It does not import a pretend movie into your library or need the
external adapter used in the initial experiment.

**This is a development checkpoint, not a supported release feature.** Keep it
on a disposable channel. [Issue #59](https://github.com/TacoRocket/tunarr/issues/59)
tracks the remaining work before it can be shipped.

## Try it on an isolated instance

Create an empty, standalone channel and select regular HLS streaming. Do not
add a schedule, redirects, or library programs to it. For the initial check,
use software H.264 video and AAC audio. Hardware encoding and CRT settings still
use the existing pipeline, but have not been validated for this source.

With that instance's address and channel ID:

```sh
TUNARR_URL=http://localhost:8000
CHANNEL_ID=replace-with-your-test-channel-id
curl --fail-with-body -X PUT \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay" \
  -H 'Content-Type: application/json' \
  -d '{"source":"toonami-aftermath"}'
```

Tune the channel through its regular HLS URL. The source is fixed to Toonami's
Eastern feed in this draft; this is not a general URL importer. Tunarr selects
the first audio stream. Subtitle selection, program markers, and credit squeeze
are not available for this live source.

To read the saved setting:

```sh
curl --fail-with-body \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay"
```

To disable it, stop viewers, send `null`, and tune again:

```sh
curl --fail-with-body -X PUT \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay" \
  -H 'Content-Type: application/json' -d 'null'
```

The setting is saved in the channel's existing lineup file. No SQL migration,
media source, or library program is created. Existing sessions are not restarted
when the setting changes, so stop viewers before enabling or disabling it.
Programming saves are refused while the relay is enabled; disable it before adding
programs or a schedule. Channels without the setting keep their existing playback path.

## What still needs work

The draft retains the initial experiment's one-hour session limit. Live inputs
no longer receive silent audio padding or file read throttling. Each new session
still probes the source with ffprobe (up to ten seconds), including restarts and
retries; that can delay recovery.

In the isolated follow-up, the final live-source segment ended without a long
silent tail. Recovery still started error fallbacks too frequently and produced
badly timed fallback segments. Shortened-session rollovers also repeated source
content. Removing audio padding fixes one cause of the outage problem, not the
whole recovery path. Continuous sessions, bounded recovery, and further native
endurance checks remain merge blockers. See the PR evidence for measurements
and the distinction between the shortened probe and the normal one-hour limit.

The guide does not follow Toonami's programs; an empty channel's placeholder
guide is not source EPG. Scheduling the feed in blocks, downstream offset
channels, native UI controls, and physical-client acceptance remain out of scope
for this checkpoint. Use the standalone test channel directly.

[Spelunkr (#126)](https://github.com/TacoRocket/tunarr/issues/126) has a separate
timed-file playlist problem. [YouTube (#127)](https://github.com/TacoRocket/tunarr/issues/127)
is exploratory and has not been tested. Neither source is enabled here.
