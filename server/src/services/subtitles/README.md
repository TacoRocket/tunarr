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

## Local PGS-to-SRT preparation

`PgsMatroskaReader.ts` reuses the buffered EBML reader above to read one selected
`S_HDMV/PGS` track directly. It passes timestamped blocks and their optional
BlockDuration to `PgsDecoder.ts`; no FFmpeg process, reduced MKV, or SUP handoff
is involved. This matters because the earlier SUP remux probe discarded the final
stored duration when the last picture had no following clear command.

`PgsDecoder.ts` adapts Subtitle Edit's presentation-composition state machine,
palette conversion, run-length bitmap decoding, object composition, default fade
merge heuristic, and OCR binarization. The source is pinned to
[`2a8815cf103da211164b7a64afcd454492768a65`](https://github.com/SubtitleEdit/subtitleedit/tree/2a8815cf103da211164b7a64afcd454492768a65):
`src/libse/BluRaySup/BluRaySupParser.cs`, `BluRaySupPalette.cs`,
`src/libse/Common/VobSubColorIsolation.cs`, and the `src/seconv/Core/`
`ImageOcrLoader.cs` and `TesseractOcrEngine.cs` path. Their MIT notice is retained
in `LICENSE.SubtitleEdit`. This is a bounded adaptation, not a claim of full
Subtitle Edit compatibility or byte-identical Skia output.

`@napi-rs/canvas` supplies Skia image composition and Mitchell scaling. It owns
the image primitive; our code owns PGS state, timing, and output decisions.
The image becomes black text on white using Subtitle Edit's alpha >= 100 and
maximum RGB >= 90 thresholds, then is enlarged 2x. `PgsToSrt.ts` invokes native
Tesseract with the selected language and `--psm 6`, one image at a time. It trims
OCR output, omits blank results with an explicit count, and writes numbered UTF-8
SRT with a BOM and LF line endings. It applies no dictionaries, translation,
spell correction, positioning, or inferred italics.

Run from `server/` in a source checkout with dependencies installed and native
Tesseract plus the requested language data on PATH:

```sh
pnpm exec tsx scripts/pgs-to-srt.ts --input /media/example.mkv \
  --stream 2 --language eng --output /output/example.eng.srt
```

The stream index is zero-based across all Matroska tracks, not just subtitles.
The output must be a new path; existing files and symlinks are never overwritten.
OCR failures and missing cue end times stop conversion before output creation.
Temporary images are removed on success or handled failure. Interrupting the
process cancels file reads and the running OCR child. Tesseract has a 60-second
per-image timeout. A forced process kill can leave its temporary directory.

Supported inputs are seekable MKVs with finite clusters, timestamps before blocks,
and unencoded, unlaced PGS. Nonzero CodecDelay and explicit TrackTimestampScale on
the selected or A/V tracks are rejected. Timestamps use TimestampScale and signed
block offsets; the earliest first A/V packet is subtracted as the source origin.
This matches the bounded probe, not every reordered-video or exotic-container
timing case. The final picture uses a following display/clear or the maximum known
stored block end; it never invents a duration. Cropped objects, missing bitmap
fragments/palettes, and malformed data fail explicitly rather than reproducing
Subtitle Edit's partial recovery. SUP input is not part of this command.

This first slice is a local command, not an installed Tunarr worker. It has no
library scan, queue, cache admission, API/UI, playback wiring, or container
packaging. Node is the local validation runtime; production Bun/container support
must be checked when this code is wired into a deployed worker. OCR output still
needs human comparison with the source images before treating it as accurate.

## Cache identity and reference retention

`SubtitleCache.ts` implements a versioned file cache with adjacent source manifests.
Extraction and playback include the same source fingerprint in the cache key and
require a matching manifest before reuse. Local fingerprints use path, size,
mtime, ctime and inode; remote sources use their URL without query tokens and the
catalog canonical ID. Remote replacement detection therefore depends on scanning.
This is file metadata validation, not a content checksum. A file changing during
extraction fails before publication, and successful replacements retire old versions.

The extraction task serializes its recurring cleanup with extraction. It reuses
`ProgramReferences.ts`, also used by Trash, to retain actual lineup, fallback,
custom-show and filler-list references independently of the lookahead window.
Missing catalog items remain until repair/removal; unreferenced healthy or deleted
items are removed. Only manifested extractions belong to this cleanup. Sidecars
and the legacy orphan sweep retain their existing ownership. Unversioned embedded
caches are not trusted and are regenerated on demand; no library rescan or database
migration is needed.

## Lookahead admission budget

`SubtitleExtractorTask` uses a fixed-window work budget: ten minutes of extraction
slot time per database in each one-hour window, starting with the first admitted
file. The process-local allowance is shared across task instances and checked
under the existing extraction mutex. Queue wait time does not count. Files airing
within the next hour bypass the admission limit but their work still counts;
later files are deferred once it is spent. Every admitted extraction can finish,
so one file or urgent work can exceed the allowance. Deferred counts are logged.
The next window refills on admission, and process restart resets the allowance.
This does not change the reader, stall watchdog, failure cooldown or sidecar downloads.
