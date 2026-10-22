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
