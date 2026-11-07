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

## Boundary signaling

Each new clip process restarts MPEG-TS continuity counters. The playlist marks
that boundary with `#EXT-X-DISCONTINUITY`; the segment packets also need the
restart flag that the output formats already intended to request. With `-f hls`,
`-mpegts_flags +initial_discontinuity` on the outer output does not reach the
nested MPEG-TS muxer. `HlsOutputFormat` and `HlsDirectOutputFormat` instead pass
`-hls_segment_options mpegts_flags=+initial_discontinuity` on subsequent
transcodes. The first-transcode condition and playlist markers are unchanged.

This does not change timestamp placement. HLS Direct V2 receives the signaling
correction but retains its existing timestamp handling. Plain MPEG-TS
output already passes the option to its owning muxer and is unchanged.

In a captured native HLS join, clearing only the transport discontinuity bits
brought back FFmpeg's corrupt-packet warning; leaving them set removed it.
Decoded audio/video hashes matched. That proves the signaling effect, not that
a particular client's intermittent freeze is resolved. Bounded Kodi playback
was healthy both before and after the correction, so it is compatibility
evidence rather than a reproduction of the reported TiviMate failure.

## Failed segment inspection

`GetSegmentStreamEndsTask` rejects a nonzero or signal-terminated `ffprobe`
exit even when stdout contains parseable packet lines. A failed probe can leave
partial output; that output must not be accepted as a successful end-time
measurement. The caller logs the failure and falls back to a zero offset.

## Program boundary offsets

Each program's transcode starts at the PTS where the previous segment ended.
`GetSegmentStreamEndsTask` reports audio and video ends separately, because
audio often runs a few milliseconds past the last video frame.
`nextProgramPtsOffset` sets the offset to the previous audio end plus the audio
encoder's lead. The encoder writes its first samples that far before the
offset, so the next program's audio starts where the previous audio ended.
The offset never starts video before the previous video ended.

`MeasureAudioEncoderLeadTask` measures the lead once per `hls` session with a
short ffmpeg probe, started when the session starts. A failed probe, or copied
audio, uses a lead of zero.
