# Live feeds — experimental

An empty Tunarr channel can play a Toonami Aftermath feed or follow
[Spelunkr's Computer Chronicles schedule](#spelunkr--computer-chronicles).
Each feed has its own normal channel name, number, icon, and M3U entry.
No pretend movie or external adapter is needed.

**This is a development checkpoint, not a supported release feature.** Keep it
on an isolated instance until review and deployment approval.
[Issue #59](https://github.com/TacoRocket/tunarr/issues/59) tracks Toonami
acceptance; [issue #126](https://github.com/TacoRocket/tunarr/issues/126)
tracks Spelunkr.

## Choose a feed

Create an empty, standalone channel. For Toonami, select **HLS** to transcode, or choose
**ErsatzTV next (Experimental)** as the playback engine and **HLS Direct v2**
to copy compatible source video and audio. Do not add library programs, redirects,
or a schedule. For an initial transcode check, use software
H.264 video and AAC audio. Hardware encoding and CRT settings use the existing
pipeline but have not been validated for this source.

HLS Direct v2 avoids decoding, resizing, and encoding compatible feeds. Your
player receives their original resolution and audio. The existing worker falls
back to transcoding when it cannot copy; CRT still requires video processing,
and loudness normalization still requires audio processing. The profile supplies
the fallback video settings. When audio cannot be copied, the existing direct-play
fallback uses AC-3 and preserves the source layout up to 5.1; it does not apply the
profile's audio bitrate, sample rate, or channel count. If loudness normalization
requires audio transcoding from the start, the profile's audio settings apply.
HLS Direct v2 live feeds require ErsatzTV next;
the legacy engine's direct mode is not enabled for this source.

Copy mode still builds an HLS buffer. Startup depends on the provider's available
segments and keyframes, so copying is not a guarantee of faster channel changes.

The New Channel Streaming tab shows these setup steps before the feed can be
selected.
After saving the new channel, open **Edit → Streaming → Configure live feed**.
Choose a feed and click **Save live feed**. This dialog saves separately from the
other channel settings; save or discard those changes before opening it. New
channels start with the live feed off. Repeat with another empty channel to add
another feed as its own channel.

Stop viewers before changing a feed. To return to ordinary programming, choose
**Off — use channel programming**. Saving never restarts viewers or clears a
lineup. If the channel is not eligible, the dialog displays the server's reason
and leaves the saved selection unchanged.

The Toonami choices are also available through the API:

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

## Toonami playback and recovery

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

## Toonami with the ErsatzTV next backend

A relay channel can also use the experimental ErsatzTV next backend. Choose
**ErsatzTV next (Experimental)** under **Playback engine** on the channel's
Streaming tab. Tunarr looks up the feed's current address for
each item and hands it to the worker as a live source. If the lookup fails, the
channel shows a ten-second error screen and asks again.

The relay is a continuous live source. A healthy feed stays connected until it
drops or viewers leave, past the item's end and across the worker's 12-hour
playout windows. The item still ends with the window it was resolved in rather
than the relay's nominal hour, but that end only describes the item.

When the feed drops, the worker shows its fallback for 30 seconds and then asks
Tunarr for the feed again, until it is back. Both need the fork's worker build,
`ersatztv-channel` 0.2.4-trfork.2 or later from
[TacoRocket/next](https://github.com/TacoRocket/next/releases), which the fork's
image bundles. The upstream worker ends a live source at its
item's end and stays on its fallback until then.

## Toonami program guide

Tunarr fetches the selected feed's schedule during its normal guide refresh.
Show names, available episode titles, and broadcast times appear in the web
guide and XMLTV under your Tunarr channel. Saving or disabling a feed requests
a guide refresh; it does not restart playback. West and Snickelodeon West use
their East schedule delayed by three hours, matching the stream selection.

Each refresh requests 75 schedule entries. Tunarr only names programs whose
start and end are known; gaps and the remainder of a longer guide window show
the channel's usual placeholder title. Feeds without a public schedule, including
Radio at the time of testing, also use the placeholder. If the schedule service
fails, Tunarr logs a warning and builds the placeholder guide. Playback continues
independently. Episode descriptions, artwork, and cast enrichment are not imported.

The provider API and West schedule mapping were checked against
[toonamiaftermath-cli](https://github.com/chris102994/toonamiaftermath-cli).
Tunarr requests the provider directly; that CLI or a separate guide container
is not required.

## Spelunkr — Computer Chronicles

Spelunkr plays individual Internet Archive files on a shared schedule. Tunarr
joins the current episode at the position shown by that schedule, then moves
to the next item at its scheduled time. This first implementation supports
**Computer Chronicles** only.

1. Create an empty, standalone channel without library programs, redirects,
   or a saved schedule.
2. On **Streaming**, select **ErsatzTV next (Experimental)** as the playback
   engine and **HLS** as the stream mode. Use a compatible transcode profile;
   H.264 video and AAC audio are a simple starting point. Save the channel.
3. Open **Edit → Streaming → Configure live feed**, select
   **Spelunkr — Computer Chronicles**, and click **Save live feed**.
4. Tune the channel through its normal HLS URL or M3U entry.

During Spelunkr's scheduled breaks, Tunarr shows the bundled **We'll Be Right
Back** card with silence for the original break duration. It does not skip the
break or start the next episode early. Spelunkr's own animated cards and music
are not reproduced. The new card's appearance on physical CRTs remains untested.

The web guide and XMLTV use the same schedule as playback, including the timed
breaks. If Tunarr cannot read the schedule, it shows its error screen and
tries again after 30 seconds. Once the schedule is available, it joins the
current scheduled position rather than replaying missed programs. An
unsupported schedule format is reported as an error instead of guessing the
program order or break lengths. The guide uses the channel's usual placeholder
when the schedule is unavailable.

A media-file failure uses the worker's existing finite-file error behavior;
this feature does not add the short outage retries used by the Toonami relay.
That recovery behavior and the worker's audio handoff remain separate follow-ups.

The API setting is:

```json
{"source":"spelunkr","feed":"computer-chronicles"}
```

Send it to the same `/api/channels/:id/experimental/live-relay` endpoint shown
above. Send `null` to return to ordinary channel programming. This first lane
requires transcoded HLS with ErsatzTV next; the legacy engine and HLS Direct v2
are not enabled for Spelunkr. Arbitrary file URLs and other Spelunkr channels
are not accepted.

The bounded timing trial established joining and video transitions with a
placeholder break. It did not establish long-running or physical-client audio
acceptance. The worker's audio handoff follow-up is separate from this feature.

## Current Toonami limits

Tunarr selects the first audio stream. Subtitle selection, program markers, and
credit squeeze are unavailable for this live source.

Scheduling live blocks, downstream offset channels, and physical-client
acceptance remain outside this checkpoint. Use standalone channels directly. The PR records the bounded software/HLS tests; those do not
establish a full-hour, release-image, physical-client, or GPU/CRT acceptance run.
A bounded Linux/Bun relay check with worker pooling passed; it used the built
backend in an isolated runtime container, not a newly packaged release image.

[YouTube (#127)](https://github.com/TacoRocket/tunarr/issues/127) remains
exploratory and is not enabled here.
