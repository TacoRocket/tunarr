# Selective Matroska subtitle extraction

`SelectiveMatroskaReader.ts` implements a seek-based EBML block filter. It reads
container headers and each block's track number, skips unselected payloads using
positional file reads, and copies selected text-subtitle blocks into a temporary
Matroska file. It also retains every original TrackEntry and the first packet of
each unselected track as timing anchors. These anchors preserve FFmpeg's normal
source start-time calculation: a source starting at five seconds with its first
subtitle at eight seconds must still produce a cue at three seconds, not zero
or eight. Remaining unselected payloads are skipped. FFmpeg converts that small file into the existing subtitle cache
formats. Audio/video decoding, subtitle text conversion, compression, and lacing
are not reimplemented here.

The selective read is adapted from Subtitle Edit's `MatroskaFile.ClusterReader.ReadSubtitleBlock`,
revision [`2a8815cf103da211164b7a64afcd454492768a65`](https://github.com/SubtitleEdit/subtitleedit/blob/2a8815cf103da211164b7a64afcd454492768a65/src/libse/ContainerFormats/Matroska/MatroskaFile.cs).
Its MIT copyright and permission notice are retained in `LICENSE.SubtitleEdit`.
This is an adaptation of its skip-before-payload mechanism, not a port of the
entire reader: instead of decoding subtitle bytes, we preserve the original
TrackEntry and selected Block/SimpleBlock data for FFmpeg, plus the first-packet
timing anchors described above. Seek indexes, segment
positions, and cluster CRCs are omitted because their offsets/checksums would no
longer describe the reduced file. Unmodified track/block-group CRCs remain valid.

The input must be a seekable file with finite clusters (the Segment may have an
unknown length). Requested indexes use the original TrackEntry order, matching
FFmpeg stream indexes for the ordinary video/audio/subtitle tracks. Output stream
indexes remain unchanged. Convert with FFmpeg's normal timestamp handling, without
`-copyts`, so the retained timing anchors determine the source origin. Only
`S_TEXT/*` subtitle tracks are accepted; unsupported structure is reported as
`UnsupportedMatroskaError` so the caller can choose the existing extraction path.
Malformed/truncated input, I/O errors, and resource limits are ordinary failures.
The caller owns cleanup of temporary output on success and failure.

Reads use a 4 KiB buffer. `bytesRead` counts all bytes delivered by file reads,
including buffering and repeated metadata reads; it is not an estimate based on
file offsets or a claim about physical disk/NAS traffic. OS read-ahead can fetch
additional bytes. Individual copied elements are limited to 16 MiB, selected
cluster data to 64 MiB, and total output to 256 MiB. Abort checks run between
reads/writes; an in-flight OS read must return before its handle can be closed.

The focused unit check reproduces the excessive-read failure with large
unselected payloads and verifies that subtitle blocks and first-packet timing anchors survive while
subsequent unselected payloads are skipped. The
copied-media comparison records subtitle text/timing fidelity and actual reader
bytes against FFmpeg separately; this README does not claim live deployment or
all-container compatibility.
