# Transcoding settings reference

The detailed version of the fork's transcoding changes, for tinkerers. Looking for the quick setup? See the [Hardware comparison](hardware-comparison.md) or [CRT looks](crt.md).

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

## Subtitle extraction

With subtitle extraction enabled in FFmpeg settings, Tunarr prepares the embedded
text track that a channel's playback rules want for its next hour of programming.
It uses the same stream-selection profile or legacy language preferences as
playback. An empty cache still gets prepared: Tunarr remembers the intended text
track even while playback temporarily falls back to another track.

Image subtitles such as PGS do not need extraction. If your channel wants English
PGS, Tunarr leaves the file alone instead of extracting its unused text languages.
External subtitle downloads still run, including on HLS Direct V2 channels.

When channels need different text tracks from the same file in the same run,
Tunarr extracts them together. A repeat run uses the cache. Selecting a new track
later can require another full read; extracting fewer tracks does not itself make
the first read smaller.

Extraction always stops after **60 seconds without media input progress**.
Long gaps between subtitle lines do not stop a healthy media read.

Once a media source has 20 successful reads with a known file size, Tunarr also
sets a total deadline before starting extraction: three times the source's
nearest-rank p95 seconds per GB, multiplied by the selected file's size in GB,
with a 60-second minimum. Progress keeps the stall watchdog alive but does not
extend this total deadline. A stopped extraction publishes no partial subtitles.

Plex's reported size is retained with the selected media file and included in
Meili's `mediaFiles` metadata. Extraction uses the catalog record it already
loads; calculating the deadline adds no filesystem or Plex request. The first
normal scan after this upgrade refreshes existing Plex program records once to
retain their sizes. No scan is started by the migration. Missing or invalid sizes,
fewer than 20 samples, and unrepresentable budgets use only the fixed watchdog.

Successful reads train a rolling history of 20 samples per source, using elapsed
time divided by catalog file size. Failed or stopped reads never train it. History
resets when the server restarts. The cached size follows Plex metadata updates;
it is not a fresh size check against storage on each extraction.

Failures keep the six-hour retry delay unless the file changes. After an adaptive
stop, the next eligible attempt uses only the fixed watchdog so a healthy slower
read can complete and update the baseline. That one-use recovery allowance expires
24 hours after the adaptive stop; restart also clears it and the learned history.
This avoids an immediate full reread and prevents abandoned recovery entries from
remaining in memory indefinitely.

Look for `Subtitle extraction timeout policy` in the log for the selected budget,
prior sample count, and fallback reason. A stopped read is reported as
`adaptive_timeout`, `stalled`, or `failed`. Completed reads still log elapsed time,
actual input bytes and progress pauses; adaptive budgets use catalog file size
consistently rather than mixing it with FFmpeg's input-byte count.

HLS Direct V2 channels skip embedded extraction because playback passes subtitles
through. A client can also request remux for an otherwise transcoded channel, but
that request is not a saved channel setting: the scheduled extractor cannot
predict it.
