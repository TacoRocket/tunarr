# Transcoding settings reference

The detailed version of the fork's transcoding changes, for tinkerers. Looking for the quick setup? See the [Hardware comparison](hardware-comparison.md) or [CRT looks](crt.md).

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

When you tune in partway through a program with a separate subtitle file, the
line already on screen at that moment is skipped; the next one shows normally.

Regular HLS also skips a cue whose timestamp falls before the new output's zero
point. Otherwise FFmpeg can shift the first WebVTT file forward and show the next
few lines late. Later cues retain their original timing relative to the video.

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
still run, including on HLS Direct V2 channels. Those channels skip embedded
extraction because playback passes subtitles through. A client can also request
remux for an otherwise transcoded channel, but that per-request choice cannot be
predicted by the scheduled extractor.
