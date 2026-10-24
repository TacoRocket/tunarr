# HLS playback buffer

`HlsSession` uses a sliding playlist for clients and a full append-only FFmpeg
playlist on disk. Old segment files are pruned; their duration entries remain in
the underlying playlist.

The schedule cursor (`transcodedUntil`) advances by the requested program duration
and selects the next scheduled item. Encoding pace uses a different measurement:
stream start plus the sum of emitted `EXTINF` durations, minus the current time.
It keeps the existing 30/60-second thresholds and initial encoding burst.

This separation matters when a container's duration exceeds its video, such as
subtitles extending beyond the final picture. Crediting that missing tail as
buffer causes unnecessary waits and leaves later transitions without the expected
headroom. Counting emitted segments avoids that wait without repeatedly selecting
the exhausted tail. It does not correct source metadata or guide durations.

This applies to the append-playlist `HlsSession` path, including direct v2. The
continuous-concatenation `HlsSlowerSession` has a different lifecycle and is unchanged.

## Encoded HLS timestamp continuity

Encoded HLS uses the measured encoder-lead mechanism from upstream PR #2368
(`19edc9c3eb2d8879b83105e1fbc880ba8f689c9b`). `GetSegmentStreamEndsTask`
finds the latest audio and non-audio packet ends in the preceding MPEG-TS segment.
`MeasureAudioEncoderLeadTask` measures the configured encoder, sample rate and
channel count with a 0.2-second silent encode; `HlsSession` caches that result
for the session. Audio copy uses zero encoder lead.

`nextProgramPtsOffset` starts the next clip at the greater of the non-audio end
and the audio end plus measured lead, then adds one 90 kHz tick. One shared
offset preserves the next clip's audio, video and subtitle alignment. A video
gap can remain when the previous audio tail determines the boundary. This
replaces the fork's AAC/AC3/EAC3 sample constants; HLS Direct V2 and HLS Slower
retain their separate timestamp paths.

The fork retains PR #2366's failed-probe protection in the replacement reader:
a nonzero ffprobe exit fails even if stdout contains parseable packets. Its
existing caller logs the failure and uses zero offset. Encoder-lead measurement
failure likewise logs a warning and uses zero lead. Neither failure path
promises audio continuity. Missing packet durations retain the 10,000-tick
estimate, and packets without PTS are skipped as in upstream #2368.

Both HLS output builders retain PR #2366's restart signaling through
`-hls_segment_options mpegts_flags=+initial_discontinuity` for subsequent clips.
Timing measurements and transport flags do not establish that every player
stall is resolved. Playlist-window policy and the concat wrapper are unchanged.
