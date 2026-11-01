# Transcoding settings reference

The detailed version of the fork's transcoding changes, for tinkerers. Looking for the quick setup? See the [Hardware comparison](hardware-comparison.md) or [CRT looks](crt.md).

## Bundled ErsatzTV next worker

This fork bundles [ErsatzTV next `v0.2.4-trfork.14`](https://github.com/TacoRocket/next/releases/tag/v0.2.4-trfork.14).
This replaces the upstream worker version listed in the shared documentation.
It includes the [video compatibility changes](#hls-direct-v2-on-ersatztv-next)
and the [eased credit squeeze](credit-squeeze.md#on-the-ersatztv-next-backend).

Tunarr refuses a bundled worker from a different release. A worker selected with
`TUNARR_ERSATZTV_NEXT_PATH` still runs if its version differs, but Tunarr logs a
warning; streams may fail in ways its schema checks cannot catch.

## HLS Direct v2 on ErsatzTV next

On the fork's ErsatzTV next backend, **HLS Direct v2** copies each program's
video and audio when it can, avoiding unnecessary re-encoding. Select that
stream mode and **ErsatzTV next (Experimental)** under **Playback engine** on
the channel's Streaming tab.

The worker can copy H.264 or HEVC video and AAC, AC-3, E-AC-3 or MP3 audio.
It re-encodes streams it cannot copy, including video with burned-in or image
subtitles, still images, generated sources, and files that do not begin on a
keyframe. It also re-encodes video most hardware players cannot decode: 10-bit
H.264, and 4:2:2 or 4:4:4 H.264 or HEVC, which Tunarr's own HLS Direct v2
copies. 10-bit HEVC still copies. Joining partway through a program can still
copy, starting from the keyframe at or before the join point.

Audio it can't copy, such as FLAC, TrueHD or DTS, is re-encoded as AC-3 in the
source's layout, up to 5.1, as Tunarr's own pipeline does. See
[Copied audio](#copied-audio-on-ersatztv-next).

Some settings also require re-encoding:

- A [CRT look](crt.md) supported by the worker keeps video re-encoding so the
  look is drawn. A look the worker cannot draw is reported as dropped and does
  not prevent copying.
- Items carrying a watermark re-encode their video. **Disable Watermarks**
  removes it, and **Hide watermark during filler** lets filler without a
  watermark remain eligible for copying.
- Loudness normalization in the transcode config keeps audio re-encoding;
  video can still copy.

Copied programs retain their source resolution and codecs. Some players may
struggle when those change between programs.

Plain **HLS Direct** stays on Tunarr's own pipeline: it hands the player one
program at a time, while the worker writes one continuous HLS playlist.
**HLS alt** also stays on Tunarr's pipeline. This change leaves **HLS** and
**MPEG-TS** behavior unchanged.

## Copied audio on ErsatzTV next

A transcode config with **Audio Format** set to **Copy / Passthrough** can back
a channel on the fork's ErsatzTV next backend, in any stream mode. The upstream
backend refuses it.

The worker copies a program's audio when it is AAC, AC-3, E-AC-3 or MP3. Other
audio, such as FLAC, TrueHD, DTS or PCM, is re-encoded as AC-3 in the source's
layout: stereo stays stereo at 192 kbps and 5.1 stays 5.1 at 448 kbps. 7.1 is
mixed down to 5.1, the most AC-3 carries, and a sample rate above 48 kHz is
resampled to one AC-3 carries. The config's audio channels, bitrate and sample
rate don't apply to copied audio. The editor greys out bitrate, buffer size and
sample rate while Copy is selected; Audio Channels stays editable but is not
used. HLS Direct v2 copies audio the same way.

Tunarr's own pipeline converts FLAC, TrueHD and DTS to AC-3 in HLS too. The
differences: it encodes 5.1 FLAC at 640 kbps, and it refuses FLAC with more
than six channels, which the worker mixes down.

Loudness normalization doesn't apply to copied audio on either pipeline. On
this backend it is listed with the settings that don't apply.

## Live fallback reports

The sessions API reports when Tunarr keeps playing with a fallback. Read
`degradations` on `GET /api/sessions`, `GET /api/channels/:id/sessions`, or a
channel's sessions. Each entry has a stable `code`, a plain `message`, and
`firstSeen` in epoch milliseconds. Reports describe the item being transcoded,
which can be ahead of what viewers see.

Alongside low-power encoding, HDR CRT bypass, and unextracted subtitle reports,
the API reports these hardware fallbacks:

| Code | Meaning |
| --- | --- |
| `hardware_decode_unavailable` | The selected VAAPI, NVIDIA, Quick Sync, or VideoToolbox path cannot decode this item on hardware and uses the CPU. |
| `hardware_encode_unavailable` | The selected hardware path cannot encode the requested output and uses the CPU. |
| `hardware_tonemap_unavailable` | VAAPI cannot use hardware tone mapping for this HDR item and uses software tone mapping. |

Tone-map fallback reporting currently covers VAAPI only. Quick Sync's software
tone-map branch runs when hardware filters are explicitly disabled, so it is
excluded from degradation reporting. NVIDIA has a Vulkan/libplacebo tone-map
path but no implemented software fallback in that builder. An empty report does
not confirm that tone mapping is running on hardware.

These reports reuse the choices the builders already make. They do not change
encoding, retry FFmpeg failures, or probe hardware again. Explicitly disabled
hardware is not a degradation. Stream copy, raw or still-image input decoding,
and deliberate raw/NUT output do not produce hardware-codec fallback notices.
Still images can report an encoding fallback when their video output uses the
CPU instead of the selected hardware encoder. Compatibility
workarounds that prevent hardware decoding, such as NVIDIA looping inputs and
QSV 10-bit H.264, do report the CPU fallback.

`subtitle_passthrough_unsupported` reports a selected image subtitle that
passthrough cannot display. The message identifies the track; video continues
unchanged without that subtitle. Directly usable embedded text does not need a
pre-extracted cache in this mode and is not reported as missing. Disabled
subtitles and selections that return no track do not produce this report.
Selection and fallback behavior are unchanged.

Reports live only in memory. Shared HLS sessions update `degradations` with each
item; continuing codes retain `firstSeen` and resolved reasons disappear.

Plain MPEG-TS and HLS Direct v1 expose `requests` instead of one combined report.
Each entry has a server-generated `requestId`, `startedAt`, the requested item's
`programId` when available, `programBeginMs`, connection details, and its own
`degradations`. The surrounding session's `instanceId` distinguishes it from a
replacement on the same channel. MPEG-TS wrapper viewers share the reports of
the producer they receive; standalone HLS Direct requests stay separate even
when viewers have the same IP address. Request IDs do not identify a person or
follow a viewer across playlist refreshes.

Overlapping requests never overwrite each other. Reasons are omitted before
setup and after a transcode ends; the request entry is removed when the media
request closes. A replacement transcode can supply new reasons while that
request remains open. Parent shutdown clears its reports. An empty reasons list
means none of the implemented codes applies, not that all possible fallbacks
are covered. An empty `requests` list means there are no active request reports.

Report-only session groups appear in API reads but do not control playback,
retries, or on-demand pause/resume. Their connection count counts active media
requests, not unique viewers. Reporting does not change what the existing stop
session action controls. These additions are API-only. The editor and
Troubleshooter UI remain separate work under
[#60](https://github.com/TacoRocket/tunarr/issues/60);
[#68](https://github.com/TacoRocket/tunarr/issues/68) remains the parent tracker.

### On the ErsatzTV next backend

ErsatzTV next sessions report through the same `degradations` field. Tunarr
reports `subtitle_not_extracted` itself. The fork's worker (TacoRocket/next
`v0.2.4-trfork.10` or later) reports what its pipeline chose for each item:

| Code | Meaning on ErsatzTV next |
| --- | --- |
| `hardware_decode_unavailable` | The channel's hardware acceleration cannot decode this item; the CPU decodes it. |
| `hardware_encode_unavailable` | The hardware acceleration cannot encode the requested output; the CPU encodes it. |
| `hardware_tonemap_unavailable` | This HDR item is tone-mapped on the CPU. Covers every hardware acceleration the worker supports, not only VAAPI. |
| `vaapi_low_power_unavailable` | Low-power VAAPI encoding was requested, and the device has no low-power encoder for this output. |
| `crt_hdr_bypassed` | The CRT look is skipped for this HDR item. |
| `crt_unavailable` | The worker cannot draw the CRT look on this machine. It needs VAAPI with libplacebo and a Vulkan device that imports VAAPI frames. |

The worker rewrites `degradations.json` beside the session's `channel.json` as
each item starts, keeping every item that hasn't ended, so a run of short clips
prepared ahead can't push out the one on air. The file stays out of the folder
served to viewers. Tunarr reports the entry for the program on air, so a
program the worker has already transcoded ahead does not replace the current
report early. `firstSeen` is when the worker first chose that fallback in the
current run of consecutive items. Nothing is reported before the worker builds
the program on air, or when the report is missing or unreadable. Settings the
backend cannot apply at all are listed as ignored settings when the session
starts, not here.

## FLAC audio in HLS passthrough

HLS passthrough converts FLAC audio to AC-3 so the output contains a usable audio
track, while copying the video. This applies to Direct HLS v2 and HLS remux in
this source revision; it requires no extra setting or compatibility script.
Audio up to stereo uses 192 kbps; three to six channels use 640 kbps. Sources
above six channels stop with an explicit error rather than silently downmixing.
This is lossy audio conversion. Non-HLS remux outputs retain their existing FLAC
behavior, and DTS/TrueHD conversion is unchanged. The published
`2026.10.4-fork.1` image predates this change.

### SDR color consistency with VAAPI

For 8-bit SDR VAAPI encoding with hardware filters enabled, Tunarr requests a
final `scale_vaapi` conversion to limited-range BT.709 with explicit matrix,
primaries, transfer, and range. This keeps those output fields consistent across
clips, including sources with incomplete color metadata. It applies with regular
or low-power encoding and does not change frame rate or timestamps.

The conversion uses the source color description provided to FFmpeg. Untagged
input still relies on FFmpeg and the driver's interpretation; this does not
recover missing source metadata. HDR/Dolby Vision inputs retain the existing
handling below. Software encoders, 10-bit output, and **Disable Hardware Filters**
are outside this SDR VAAPI conversion path.

## H.264 VAAPI low-power encoding (fork option)

The API-only transcode profile field `vaapiLowPower` selects FFmpeg's
`h264_vaapi -low_power 1` encoding path. New and existing profiles default to `false`; false preserves the existing
encoder command. Omitting the optional field on an update preserves its saved
value, so older clients do not reset it. Set it back to `false` to return
to regular encoding. This is independent of the channel's CRT preset.

Read the profile with `GET /api/transcode_configs/:id`, then submit the complete
profile to `PUT /api/transcode_configs/:id` with `vaapiLowPower: true`. Profiles
can be shared by several channels: duplicate a shared profile first when only
one channel should change. The next playback session uses the new setting.
There is no UI control in this fork change.

This option requests H.264 VAAPI low-power encoding when the device supports it.
If the device lacks the low-power entrypoint or a usable low-power rate-control
mode, Tunarr uses regular H.264 VAAPI encoding when available. The server logs
each reason at warning level once per server process, with repeats at debug
level. The saved option stays enabled,
so a later stream can use low-power encoding if the hardware supports it again.
The fallback uses the regular entrypoint's rate control; supported low-power
encoding keeps its own rate-control selection.

This does not hide an invalid profile: non-H.264/non-VAAPI settings, disabled
hardware encoding, unsupported H.264 output, or no usable encoder still fail.
The driver and FFmpeg can also reject an advertised mode at runtime (for
example, if required firmware is unavailable); this change does not retry those
failures. The editor and Stream Troubleshooter do not yet show a fallback notice
([tracked in #60](https://github.com/TacoRocket/tunarr/issues/60)); use the server
log for the reason. Remux/passthrough does not encode
video, so the option has no effect there. Other codecs and hardware backends are
outside this option's scope.

On supported Intel hardware this uses VDEnc, which can reduce competition with
CRT rendering for GPU resources. It is optional, not a universal quality or
performance recommendation.

On the [ErsatzTV next backend](../configure/ffmpeg/ersatztv-next.md), the worker
does the encoding. Tunarr passes this option on as the worker's
`vaapi_low_power: always`, which uses low power for H.264 as well as HEVC under
the same rule. When the device has both encoders, the worker uses low power only
if it supports bitrate rate control, and otherwise uses the regular encoder. A
device with only the low-power encoder keeps the worker's usual choice: it
encodes with low power either way, at constant quality where bitrate rate
control is missing. With the option off, Tunarr leaves the choice to the worker,
which prefers low power for HEVC only. `always` comes
from the fork's worker build (TacoRocket/next, since `v0.2.4-trfork.1`), which
the fork pins.

### Picture-quality trial and limits

The operator compared regular and low-power samples on a TV and reported no
meaningful visible difference. Both used Classic Flat / Performance CRT at
1920x1080, H.264 VAAPI target **8 Mbps**, maximum **8 Mbps**, **16 Mbps** buffer,
and AAC **192 kbps stereo**. The sources were:

| Source | Excerpt | Input video |
| --- | --- | --- |
| Digimon S02E04 | 05:00–05:20 | HEVC, 960x720, 24000/1001 fps |
| Sailor Moon S01E25 | 18:00–18:20 | HEVC, 1440x1080, 24000/1001 fps |
| Pepsi Blue / Papa Roach (2002) | 00:14–00:26 | H.264, 480x360, 30 fps |

These short samples support that particular viewing choice, not identical
quality across all material. Suitability at higher **output bitrates** remains
unknown, as does suitability for high-quality remux **source material** being
transcoded. A remux input's bitrate is distinct from the configured output
bitrate; selecting a remux source does not mean Tunarr preserves its bitrate.
Native-resolution 4K, HDR, other devices, and other codecs were not validated by
this trial. Compare representative material at your intended output settings
before enabling the option elsewhere.

## VAAPI driver-default scaling (fork option)

Set `TUNARR_VAAPI_DEFAULT_SCALING=1` on the server to request
`mode=default` on `scale_vaapi` for video resizing, anamorphic correction, Broadcast
CRT pre-scaling and bitmap subtitle resizing. FFmpeg normally requests `hq`
when the mode is omitted. Intel's driver can use its dedicated scaler for the
explicit default request, reducing work on the programmable render engine.
The driver still chooses the implementation; this does not force a particular
engine on every GPU.

The option leaves format-only conversions, shaders, color settings, dimensions
and encoder settings unchanged. Scaling pixels can differ from HQ; this is a
picture-quality trial, not a byte-identical replacement. Unset the variable or
set it to `0` and restart the server to restore the previous scaling commands.
No profile migration or FFmpeg rebuild is required.

CRT channels instead use their processing tier: Quality keeps baseline scaling;
Performance and Experimental request the dedicated scaler. Their tier takes
precedence over the global scaling flag, including bitmap subtitle scaling.

## Fixed-Hable VAAPI LUT (fork option)

`TUNARR_VAAPI_HABLE_LUT=1` selects the optional `tonemap_vaapi_lut` filter for
10-bit, limited-range BT.2020 non-constant-luminance/PQ video. Tone mapping and
hardware filters must already be enabled. The FFmpeg image must be built with
`VAAPI_HABLE_LUT=1`, which bundles the filter and its table; no extra volume or
host installation is needed.

Unset or `0` keeps the configured tone mapper, which defaults to OpenCL. The
flag is read at runtime, so the same staged image can be enabled or disabled
with a container environment change and restart. The environment option itself
does not change the database.
HLG, video identified as Dolby Vision, and unknown or different color encodings
retain their current path. For CRT-enabled channels, Performance and Experimental allow this LUT, which
keeps DVD Broadcast in the CRT look on eligible HDR10. Quality retains the
configured tone mapper and the HDR CRT bypass.
Non-CRT channels retain the global opt-in behavior. If FFmpeg lacks the
filter, Tunarr logs a warning and uses the configured tone mapper. If the driver
cannot run the selected LUT, FFmpeg reports an error; turn the flag off to return
to the previous route.

This is a fixed 1000-nit Hable transform with BT.709 NV12 output. It does not
include normal OpenCL's scene adaptation and is not an exact picture match to
that default. The packaged module checks its required hardware LUT layout; only
Intel Gen12 has been exercised so far. See the
[FFmpeg module](https://github.com/TacoRocket/ErsatzTV-ffmpeg/tree/feat/vaapi-hable-lut-package/features/vaapi-hable-lut)
for build, upgrade, attribution and input limits. Hardware resource measurements
from the isolated probe do not establish power savings or other-GPU performance.

## Subtitles in Direct HLS v2

When a Direct HLS v2 channel shows a text subtitle, FFmpeg writes it next to
the video: every video segment gets a subtitle file covering the same seconds,
empty when nobody is talking. Tunarr's subtitle playlist lists one of those
files per video segment, so its timeline matches the video's, program changes
included. This works the same for subtitles inside the video file and for a
separate file such as a sidecar `.srt`, and needs no extra setting or
compatibility script.

On the legacy pipeline, tuning in partway through a program with a separate
subtitle file skips the line already on screen; the next one shows normally.

Regular HLS also skips a cue whose timestamp falls before the new output's zero
point. Otherwise FFmpeg can shift the first WebVTT file forward and show the next
few lines late. Later cues retain their original timing relative to the video.

With ErsatzTV Next, Tunarr preserves the timing map written by Next when serving
WebVTT over HTTP. Legacy output without a map still receives the zero-based map.
Next includes the remainder of a cue active at tune-in. A standalone AVPlayer diagnostic skipped that cue during live startup,
while subsequent cues played normally. AVPlayer is a test client, not a Tunarr
component or proof of how TiviMate or UHF behaves. The startup cause remains under
investigation, including Tunarr's playlist and timing output; a prepared cache
does not guarantee that first line will appear.

When a preferred embedded text track has not been extracted, Next sessions report
`subtitle_not_extracted` through the sessions API, including whether another
track is being shown. The warning follows the scheduled program and clears when
that program ends or a later selection no longer needs the fallback. Preparation
can prevent this condition, but enabling preparation does not guarantee every
track is ready before playback.

## Automatically prepare upcoming subtitles

Automatic preparation finds or converts English subtitles ahead of upcoming
programs so later airings can reuse them. Enable it through the FFmpeg settings
API using `enableAutomaticSubtitlePreparation`. This separate setting defaults
to `false`; enabling embedded-text extraction does not enable library downloads or
OCR. There is no web UI control for automatic preparation.

Read the current settings, choose the preparation mode, and send the complete
settings back. For example, with `curl` and `jq`:

```sh
curl --fail --silent --show-error 'http://localhost:8000/api/ffmpeg-settings' \
  | jq '.enableAutomaticSubtitlePreparation = true | .automaticSubtitlePreparationMode = "selected"' \
  | curl --fail --silent --show-error -X PUT \
      'http://localhost:8000/api/ffmpeg-settings' \
      -H 'Content-Type: application/json' --data-binary @-
```

Use your server's address and authentication if required. Repeat with `false`
to disable it. The read-modify-write preserves your other FFmpeg settings;
avoid changing them elsewhere while sending the update.

`automaticSubtitlePreparationMode` has two choices:

| Mode | What gets prepared |
| --- | --- |
| `selected` (default) | Tracks selected by each channel's subtitle preferences. English acquisition runs only when the profile would select the resulting external SRT or ASS. |
| `all_english` (opt-in) | A non-forced, non-SDH English copy for every upcoming program on subtitle-enabled channels, even when playback preferences reject it. Selected embedded text is still extracted too. |

To keep the broader “cache all” behavior, use `"all_english"` instead of
`"selected"` in the command above. This means upcoming English preparation, not
all languages or a whole-library scan. The automatic-preparation switch must
also be enabled. Existing configurations without a mode use `selected`.

Both modes use the existing six-hour guide lookahead at startup, hourly, after
guide updates, and when you enable preparation or change its mode while enabled.
Regular transcoded HLS, other streaming modes, and HLS Direct V2 on either the
legacy or ErsatzTV Next pipeline are eligible. Enabling transcoding alone does
not enable preparation. Programs shared by multiple channels reuse their cache.

Usable text and cached tracks come first. Selected embedded text is extracted
even when the separate extraction switch is off. In `selected` mode, the same
playback selector checks whether acquired English text would be used, including
its codec, title and SDH classification. Text rejected by that profile, such as excluded
commentary, does not stop acquisition. Plex, Jellyfin or Emby metadata may still be read
when preliminary candidates are rejected: a title-dependent profile needs the
actual track title before deciding. Rejected tracks are not imported and OCR
runs only if its SRT output is eligible. In `all_english` mode, matching English
text is also extracted regardless of the profile; matching uses format,
language, forced and SDH metadata, without playback title filters.

When acquisition is needed, the single-program job below checks existing subtitles
on the configured Plex, Jellyfin or Emby library item. It copies attached English SRT or ASS files
into Tunarr’s cache, then tries English PGS OCR if there is no suitable text.
Automatic preparation never runs an online subtitle search or changes the provider's selection.
Ambiguous results still need selection. Incomplete embedded SDH metadata limits
PGS classification as described below. OCR requires the Linux container and
locally accessible Matroska media. Explicit SDH requests remain available through
the single-program job in either mode.

Playback selection is unchanged. Allow external English text to use an acquired
SRT; a profile can still prefer another language or an image subtitle. A 720p and
a 1080p transcode profile can reuse the same subtitle. `all_english` does not force
either channel to display the prepared copy.

Library-import/OCR jobs run in earliest-airing order after the existing text-extraction work.
They share its ten-minute hourly allowance for starting work, including across
guide updates. Once ten minutes have been spent, no further acquisition starts
until the allowance resets. An admitted OCR job keeps its own 30-minute deadline
and can continue past the allowance. For example, a job admitted after 9m59s of
earlier work can run another 30 minutes, bringing the total to 39m59s before the
next job is deferred. Provider/setup waits and cancellation cleanup can add time;
this is not a strict hourly runtime or CPU/disk quota. Acquisition has no
urgent-program bypass. Large queues, slow media or late schedule changes can
therefore leave a program unprepared at airtime.

Ambiguous library or PGS results remain `needs-selection`; Tunarr does not guess or
skip ambiguous library results to try OCR. Outcomes appear in the subtitle task log
and the foreground time-filter task result. Use the single-program request below
to make a selection. Provider failures stop that program while other programs
continue. Unresolved outcomes are retried after six hours; manual program requests
can retry immediately. This cooldown and the work allowance reset on restart.
Disabling the setting prevents new automatic jobs; an admitted job can finish.

Cache retention, OCR wording limits and the partway-through WebVTT limitation
still apply. Automatic preparation adds no online search or Bazarr adapter.

## Prepare subtitles for one program

The existing subtitle task accepts a single-program request. It reuses a matching
English embedded text track or source-valid acquired cache first, reads existing
subtitle files attached to the program in Plex, Jellyfin or Emby next, and tries
English PGS OCR when no suitable text is available. It does not
run online subtitle searches or change the hourly text-extraction schedule.

Use the foreground task API to receive the result:

```sh
curl -X POST 'http://localhost:8000/api/tasks/SubtitleExtractorTask/run?background=false' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"type":"program","programId":"PROGRAM_UUID","sdh":false}}'
```

The default requests non-forced, non-SDH English text. Set `sdh` to `true` for SDH.
A usable cache returns `cached`; an existing text track returns
`existing-text-track` and uses normal playback extraction when needed. A new
library or OCR copy returns `prepared` and its provider. Playback still uses the
subtitle preferences described below; preparing a track does not select it on
all channels.

Exactly one suitable attached English SRT or ASS is imported automatically. Multiple
tracks return `needs-selection` with library stream IDs, codecs and titles. Repeat
with `plexStreamId` for Plex or `libraryStreamId` for Jellyfin/Emby inside `filter`
to choose an attached track. Copy the returned ID exactly; the Jellyfin/Emby ID
includes both the media source and stream index. An explicit choice is honored
even if another track is already cached. An unknown ID
returns the current list. The former `plexCandidateId` online-search parameter is
rejected; it is not a library stream ID. A provider error fails the job rather than
starting OCR. Import only reads the item and its existing subtitle file; it does
not attach a new track or change the provider's selection. Items must have one
media version; Plex items must also have one part. Jellyfin/Emby use the existing
configured server and account, which must be allowed to read the item and subtitle.

SRT and ASS responses are preserved in their original format in Tunarr-owned cache,
with the same library/Trash retention rules below. ASS styling remains in the
cached file for playback paths that support it. Conversion to WebVTT still cannot
preserve full ASS typesetting, animation or karaoke. Embedded text continues
through the existing extraction path; embedded PGS uses the existing OCR reader
rather than a media-server subtitle-file download. A provider can normalize line
endings; Tunarr preserves the delivered text, including ASS styles.

If OCR has multiple matching tracks, the job also returns `needs-selection`.
Repeat with `ocrStreamIndex`, the zero-based stream index across all tracks.
Embedded SDH metadata is incomplete: an explicit stream selection lets you declare
its SDH classification using `sdh`. Selection does not bypass text/cache reuse or
library ambiguity. No English PGS returns `unavailable`; an unsupported runtime or
remote-only input returns `unsupported`. OCR requires the Linux container and a
locally accessible Matroska file, and keeps its existing 30-minute deadline and
exclusive worker. Closing the HTTP request does not cancel the job. The default
background task API only acknowledges submission; use `background=false` to see
selection results and failures.

Existing SRT/ASS imports do not need a local MKV or Tesseract. For OCR, a mounted
NAS share is filesystem-accessible when Tunarr can open its path; an HTTP URL alone
is not. [URL input](https://github.com/TacoRocket/tunarr/issues/182) and
[native macOS/Windows OCR jobs](https://github.com/TacoRocket/tunarr/issues/183)
are deferred. Bazarr remains separate. Cache retention, OCR quality limits and
the partway-through WebVTT limitation below still apply.

## Explicit online subtitle search through Plex

Tunarr can keep an English SRT fetched through your configured Plex server, so
later airings can reuse it even after Plex stops listing the downloaded track.
This is an explicit online-search command for one program, separate from automatic
preparation and the single-program task above. It does not search the whole library.

Use the existing Plex media source in Tunarr; no separate account or subtitle
service configuration is needed. Plex must be able to use its on-demand subtitle
search, and the configured Plex account must be allowed to manage subtitles.
A shared server may refuse the request. Run the command inside your Tunarr
container, replacing `tunarr` with its container name and `PROGRAM_UUID` with
the program's Tunarr ID:

```sh
docker exec tunarr /usr/local/bin/bun /tunarr/app/bundle.cjs \
  --database /config/tunarr prepare-plex-subtitle PROGRAM_UUID
```

The command first checks for a matching acquired copy or an existing English text
track. Otherwise it lists Plex search results. Choose a release matching your
video, then repeat with `--candidate-title 'Exact title from the result'`.
Add `--sdh` to both commands to require subtitles for deaf and hard-of-hearing
viewers. The default requires non-SDH, non-forced English SRT. Existing text is
reported rather than replaced; an embedded track may still need normal extraction.

Fetching downloads the subtitle into Plex and attaches it to the item, where it
remains available to Plex clients. Plex also selects the downloaded track.
Tunarr copies its SRT and restores the previous selection before reporting
success. It avoids overwriting a different selection made during the fetch.
If a request fails, times out, or the command is interrupted, check Plex's
selection: an asynchronous download may finish after the command stops.
This first version supports items with one media version and one part.

The copy stays while the program remains in the library, even when no channel
uses it or it is in Trash awaiting recovery. A Plex metadata rescan does not
remove it. Emptying Trash or deleting the program makes its copy eligible for
cleanup on the next subtitle task run. Retention does not transfer the copy to
a different program ID during Trash repair. Replacement media invalidates it
using the same source checks described below; remote-only changes become visible
after a scan. The cache must live on persistent Tunarr storage.

Playback uses the existing subtitle preferences. Enable subtitles and allow
external English text. Turn off image-based subtitles in that preference to use
text instead of embedded PGS. A profile requiring forced/default tracks or a
particular title may exclude the acquired copy. With WebVTT enabled, Tunarr converts the SRT
for its existing HLS subtitle path. The Direct HLS v2 tune-in limitation above
still applies. Acquisition does not check translation quality or correct timing
for the chosen release. OCR, automatic provider fallback and Bazarr are not part
of this command.

## Prepare an English PGS subtitle with OCR

For a title without usable text subtitles, Tunarr can convert a selected English
PGS track into a reusable SRT. It uses the Subtitle Edit–derived reader and image
preparation with native Tesseract. The video is read directly; no SUP remux or
media-file change is involved.

Run this in the Linux container with the program's Tunarr ID and the PGS track's
zero-based stream index across **all** tracks:

```sh
docker exec tunarr /usr/local/bin/bun /tunarr/app/bundle.cjs \
  --database /config/tunarr prepare-pgs-subtitle PROGRAM_UUID --stream 2 --sdh
```

Use `--sdh` only when the selected track includes descriptions for deaf and
hard-of-hearing viewers. The command requires an embedded English PGS track and
a locally accessible Matroska file, including a correctly mapped network mount.
The container pins Tesseract 5.5.3 and the English `tessdata_fast` 4.1.0 recognition
data, with SHA-256 checks for both downloads. Other languages and remote
HTTP inputs are outside this command's scope.

The command submits OCR through Tunarr's shared worker system and prints read/OCR
progress. One extra worker starts on demand exclusively for OCR, preserving all
configured scheduling workers. A one-worker setting can therefore use two threads
while OCR and scheduling are active. With scheduling workers disabled, scheduling
stays inline but OCR still uses its isolated worker. The OCR worker retires when
idle (60 seconds by default).

Only one conversion runs per subtitle cache and one OCR request per pool; another
reports busy and can be retried. A matching completed result returns `cached`
without OCR. The job has a 30-minute deadline. SIGINT, SIGTERM or that deadline
requests cancellation. Tesseract gets five seconds to exit before forced
termination. Responsive cancellation waits for cleanup; if the worker does not
reply within 30 seconds, the request fails and only the OCR worker is terminated.
Scheduling jobs stay on their own workers. A replacement OCR worker cannot start
until the old worker exits, including when the operating system delays that exit.

Incomplete output stays outside the playable cache. Handled failures remove it;
leftovers after a hard kill or power loss are removed by the next OCR request or
startup/hourly cache maintenance. Cleanup skips an active conversion.

Completed results use the same source checks, Trash retention and subtitle
preferences as fetched Plex subtitles above. Allow external English subtitles
and turn off image-based preference to select the generated text. WebVTT uses
the existing playback path, including its tune-in limitation: a cue already in
progress can be skipped, while subsequent cues retain their timing.

OCR may misread text and does not preserve PGS positioning or styling. Review the
result before relying on its wording; successful conversion does not establish
whole-track accuracy. The command is explicit: it does not run a library scan,
change Plex, or automatically invoke the Plex/OCR/Bazarr ladder.

## Subtitle extraction

With subtitle extraction enabled in FFmpeg settings, Tunarr prepares the embedded
text tracks wanted by its channels for the **next six hours**. The existing task
runs at startup, hourly, and after guide updates. It uses the same stream-selection
profile or legacy language preferences as playback. An empty cache still gets
prepared while playback temporarily falls back to another track.

Programs are prepared in earliest-airing order. Channels sharing a file combine
their requested tracks into one extraction, and overlapping task runs share a
single extraction slot. Missing embedded tracks airing within the next hour are
always attempted, subject to the existing failure cooldown. Later files share a
**ten-minute work allowance per hour**, across hourly runs and guide updates.
Time spent preparing urgent files counts toward that allowance too. Once spent,
Tunarr logs the deferred file count and leaves later files for another run.
An extraction already in progress finishes; this is a limit on starting more
work, not a ten-minute deadline that cuts a file off. A process restart starts a
fresh allowance. External sidecar downloads retain their existing behavior.

Completed cache files are reused by later airings, even
outside the six-hour window. Retention checks the same actual channel lineups,
fallbacks, custom shows and filler lists as Trash. Missing items keep their cache
while awaiting repair; an unused healthy item or a removed item with no remaining
references loses its cache on the next task run.

Embedded caches are tied to the media file. Playback and extraction check local
file path, size, modification/change times and inode without reading its contents.
An upgrade at the same path gets a new cache entry, and successful preparation
removes the superseded entries. Remote-only files use the source URL and scanned
program identity, so replacements become visible after the media scan. Existing
unversioned extractions are prepared once again when needed because their source
file cannot be verified. External sidecar handling is unchanged.

This is advance preparation, not a guarantee that every file will finish before its
airing: newly scheduled content and failed or slow reads can still miss the window.

For locally accessible MKV, MKS and WebM files, Tunarr uses a selective Matroska
reader adapted from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit).
It reads block headers and skips unneeded video/audio payloads. Selected subtitle
blocks, track metadata and a first-packet timing anchor for each other track go
into a small temporary Matroska file. FFmpeg converts that file into the normal
subtitle cache, preserving its source timing. No separate service or .NET runtime
is required. The port's attribution and limits are in
[`server/src/services/subtitles/README.md`](../../server/src/services/subtitles/README.md).

HTTP sources, other containers and unsupported Matroska structures retain the
existing FFmpeg extraction path. That fallback can read the full media file.
Malformed files and read failures enter the existing six-hour retry cooldown,
with an earlier retry when the source changes. Partial cache files are never
published. Temporary extraction files are removed after success or failure.

The fixed **60-second no-progress watchdog** remains. The selective reader watches
actual file-read progress; the FFmpeg fallback watches copied media bytes so long
gaps between subtitle lines do not stop a healthy read. An OS read already in
flight must return before the selective reader can close its file. No learned
wall-clock deadline is enforced. Logs separate selective source bytes from the
small-file FFmpeg conversion bytes; these are application reads, not physical NAS
traffic or a cold-storage speed benchmark.

Image subtitles such as PGS do not need extraction. If a channel wants English
PGS, Tunarr leaves its unused text languages alone. External subtitle downloads
still run, including on HLS Direct V2 channels. The extraction-only setting
skips embedded extraction on the legacy Direct V2 pipeline, where playback
passes subtitles through. Automatic preparation covers every streaming mode: it extracts selected
text there in `selected` mode, or also prepares matching English text when
`all_english` is chosen. Next-routed channels also extract selected text with the
extraction-only setting. A client can also request remux for an otherwise transcoded channel,
but that per-request choice cannot be predicted by the scheduled extractor.

## HDR tone mapping on ErsatzTV Next

**ErsatzTV Next tone mapping** lets you choose SDR output, preserve HDR when it
fits your output settings, or require HDR preservation. Find the default under
**Settings → FFmpeg**. A transcode config's **Video** settings offer the same
choices plus **Use global**. Existing configs inherit the global default,
**On**. Changes apply when the next playback session starts. Playback changes
are reported in the status API's `degradations` field on `/api/sessions` and
`/api/channels/:id/sessions`.

| Mode | What happens to HDR video |
| --- | --- |
| **On** | Converts HDR to SDR. |
| **SDR fallback** | Keeps HDR when the output supports it. Otherwise converts the item to SDR, including Dolby Vision profile 5 or an 8-bit output setting, and reports `hdr_tone_mapped` in the status API. |
| **Off** | Never converts HDR to SDR. An incompatible item reports `hdr_preservation_unsupported` in the status API and uses the channel's fallback instead. |

To preserve HDR, choose compatible output settings, set **ErsatzTV Next video
bit depth** to **10-bit**, and use an HDR-capable display. An 8-bit profile with
**Off** can still play SDR; the worker checks compatibility for each program.
SDR items and copied video keep their normal processing. SDR-only custom shaders
are skipped when HDR is preserved.

These controls apply only to ErsatzTV Next. Tunarr's own playback pipeline does
not use the profile's video bit depth field and retains its existing tone-mapping
controls. The existing `TUNARR_VAAPI_HABLE_LUT=1` option is also passed to Next as
`normalization.video.hdr_vaapi_lut`; it chooses the optional VAAPI Hable LUT when
an item needs tone mapping, without changing the selected mode.

## Preserve source aspect on ErsatzTV Next (API only)

Source-aspect preservation lets a 4:3 program fill a 4:3 display while a widescreen
player adds its own side bars. Widescreen programs can still fill widescreen
displays. The worker keeps the profile's encoded width and height and signals each
program's display shape instead of baking every program into the profile's shape.

This opt-in option requires a supporting ErsatzTV Next worker release. The
currently pinned `v0.2.4-trfork.14` worker does not support it; the caller change
must remain a draft until a supporting release is bundled.

Once that worker is available:

1. Read the profile with `GET /api/transcode_configs/:id`.
2. Set `nextPreserveSourceAspect` to `true` in the returned profile and send it to
   `PUT /api/transcode_configs/:id`. Use the full profile; this endpoint is not a
   partial update.
3. Start a new playback session on a channel using that profile and the
   ErsatzTV Next backend.

Set the field to `false` to restore the profile's usual aspect behavior. Existing
profiles and new profiles that omit it default to `false`. Omitting it from a
later update leaves the saved choice alone. Profile copies retain the choice.
There is no UI control. Tunarr's native backend is unchanged, and video copy mode
still copies eligible video; the option affects items that the worker transcodes.

The worker renders the picture and overlays in the program's display shape
before mapping them to the fixed encoded size. It does not detect or remove bars
already present in the source. A local worker run with software encoding, a
watermark, and burned subtitles kept a 960×540 encoded frame while changing display
shape from 4:3 → 16:9 → 4:3. A synthetic browser comparison also displayed those
shapes correctly. Hardware encoding, physical TV, and output-adapter compatibility
remain unverified. A player or adapter that forces a fixed display shape can still
add bars downstream.
