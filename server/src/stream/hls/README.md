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

`GetLastPtsDurationTask` scans the last MPEG-TS segment for the maximum packet
end across all streams, retaining the audio end separately. File order does not
identify the latest end: an earlier-written audio packet can outlast the final
video packet. `HlsPtsOffset.ts` takes the greater of that maximum and the audio
end plus the next encoder's priming delay, then adds one 90 kHz tick.

The native AAC encoder primes 1024 samples; AC3/EAC3 prime 256 samples
(`initial_padding` in FFmpeg's `aacenc.c` and `ac3enc.c`). The configured sample
rate converts those samples to MPEG-TS ticks, rounded up. Other configured
formats retain zero priming compensation; this fix does not establish their
boundary behavior. Audio copy does not introduce a new encoder delay.

The offset moves the whole next clip, including its subtitle output. It does not
shift audio relative to video or discard the previous clip's audio tail. A video
gap can remain where audio outlasts video. No audio is re-encoded in the concat
wrapper. HLS Direct V2 bypasses this calculation and keeps its existing contract.

Probe failures still use `HlsSession`'s existing logged zero-offset fallback;
continuity cannot be promised on that failure path. Missing packet durations
retain the existing 10,000-tick estimate. Packet checks establish timing, not a
particular player's handling of discontinuities or perceptual lip sync.
