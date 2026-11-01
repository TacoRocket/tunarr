# Toonami live relay — draft experiment

An empty Tunarr channel can play a selected Toonami Aftermath network feed.
Tunarr resolves the feed through the provider's public endpoint and transcodes
it with that channel's profile. Each feed can have its own normal channel name,
number, icon, and M3U entry. No pretend movie or external adapter is needed.

**This is a development checkpoint, not a supported release feature.** Keep it
on an isolated instance until review and deployment approval.
[Issue #59](https://github.com/TacoRocket/tunarr/issues/59) tracks acceptance.

## Choose a feed

Create an empty, standalone channel and select regular HLS streaming. Do not add
library programs, redirects, or a schedule. For the initial check, use software
H.264 video and AAC audio. Hardware encoding and CRT settings use the existing
pipeline but have not been validated for this source.

Use one of these `feed` values:

| Feed | Value |
| --- | --- |
| Toonami Aftermath East | `est` |
| Toonami Aftermath West | `pst` |
| Snickelodeon East | `snick-est` |
| Snickelodeon West | `snick-pst` |
| MTV97 | `mtv97` |
| Movies | `movies` |
| Toonami Aftermath Radio | `radio` |

West requests the provider's three-hour delay. Radio currently supplies video
artwork along with audio. The website marks some channels with access roles;
Tunarr uses only the public stream endpoint and does not supply credentials or
bypass access checks. A refused or unavailable feed enters the error-screen
recovery path. It never substitutes a different feed.

With the isolated instance's address and channel ID:

```sh
TUNARR_URL=http://localhost:8000
CHANNEL_ID=replace-with-your-test-channel-id
curl --fail-with-body -X PUT \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay" \
  -H 'Content-Type: application/json' \
  -d '{"source":"toonami-aftermath","feed":"est"}'
```

Repeat with another empty channel and a different `feed` to add another entry.
Omitting `feed` retains the draft's previous Eastern selection. Arbitrary stream
URLs are not accepted. Tune through the channel's regular HLS URL or M3U entry.

To read the saved selection:

```sh
curl --fail-with-body \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay"
```

Stop viewers before changing the selection. To disable the relay, send `null`:

```sh
curl --fail-with-body -X PUT \
  "$TUNARR_URL/api/channels/$CHANNEL_ID/experimental/live-relay" \
  -H 'Content-Type: application/json' -d 'null'
```

The setting lives in the existing channel lineup file. No SQL migration, media
source, or library program is created. Changing it does not restart existing
sessions. Programming saves are refused while the relay is enabled; disable it
before adding programs or a schedule. Channels without the setting retain their
existing playback path.

## Playback and recovery

A healthy feed stays connected until viewers stop or the source ends. There is
no hourly restart that replays the source's trailing HLS window. Live input has
no file read throttle or silent audio padding.

When setup fails or the source process exits, Tunarr plays a ten-second error
screen, then resolves and probes the same selected feed again. Retries run one
at a time. An elapsed-time delay remains even if the error screen fails, so a
broken fallback cannot trigger a rapid retry loop. Stopping the channel cancels
that delay. Each resolution and probe can take up to ten seconds; recovery is
not instantaneous and may leave a playback pause. Error screens use continuous
video and silence rather than a single video frame with a long audio tail.

This is a relay of the provider's live window. After a real outage, Tunarr rejoins
that window; it cannot restore content the provider no longer serves.

## Current limits

Tunarr selects the first audio stream. Subtitle selection, program markers, and
credit squeeze are unavailable for this live source. The guide does not follow
Toonami's programs; an empty channel's placeholder guide is not source EPG.

Scheduling live blocks, downstream offset channels, native source-selection UI,
and physical-client acceptance remain outside this checkpoint. Use standalone
channels directly. The PR records the bounded software/HLS tests; those do not
establish a full-hour, Bun-container, or GPU/CRT acceptance run.

[Spelunkr (#126)](https://github.com/TacoRocket/tunarr/issues/126) has a separate
timed-file playlist problem. [YouTube (#127)](https://github.com/TacoRocket/tunarr/issues/127)
is exploratory. Neither source is enabled here.
