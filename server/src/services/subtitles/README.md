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
`ImageOcrLoader.cs` and `TesseractOcrEngine.cs` path. The PGS parser and palette carry their own
Apache-2.0 notices (Copyright 2009 Volker Oth, converted and modified by Nikse);
those notices are retained in `PgsDecoder.ts`, with the full license in
`LICENSE.PGS-Apache-2.0`. The common/seconv code's MIT notice remains in
`LICENSE.SubtitleEdit`. This is a bounded adaptation, not a claim of full
Subtitle Edit compatibility or byte-identical Skia output.

The retained mechanisms each serve the selected-track conversion:

- PCS state and immutable object/palette snapshots preserve display changes and
  reused objects. ODS fragment assembly and RLE decoding reconstruct the pixels.
- Palette conversion and Porter-Duff source-over composition preserve overlapping
  objects at their PCS offsets; a transparent overlay must not erase underlying text.
- The default fade merge retains one bitmap and the combined timing for repeated
  fade frames, avoiding duplicate OCR captions.
- Alpha >= 100 and maximum RGB >= 90 produce black text on white. A fixed 2x
  Mitchell-Netravali filter (B = C = 1/3) retains the original scaling mechanism.
  Nearest-neighbor and bilinear were tried against the complete real track and
  introduced new OCR errors; this small fixed-scale filter avoids a native image
  dependency without changing that preparation step.

`PgsDecoder.ts` uses byte buffers for composition and emits binary grayscale PGM
(P5). `PgsToSrt.ts` pipes it directly to native Tesseract's stdin with the selected
language and `--psm 6`; stdout supplies the text. There are no image files or image
packages. It trims OCR output, omits blank results with an explicit count, and
writes numbered UTF-8 SRT with a BOM and LF line endings.

For `eng` only, `PgsOcrText.ts` repairs the observed vertical-bar/capital-I error
when the bar is standalone or adjacent to letters/apostrophes. This narrow
adaptation of Subtitle Edit's pinned `Dictionaries/eng_OCRFixReplaceList.xml`
(MIT) does not port its dictionary-gated replacement engine. Mixed-language jobs
are unchanged. Other spelling, translation, positioning and inferred italics are
outside this slice; legitimate standalone bars in English text may be changed.

Run from `server/` in a source checkout with dependencies installed and native
Tesseract plus the requested language data on PATH:

```sh
pnpm exec tsx scripts/pgs-to-srt.ts --input /media/example.mkv \
  --stream 2 --language eng --output /output/example.eng.srt
```

The stream index is zero-based across all Matroska tracks, not just subtitles.
The output must be a new path; existing files and symlinks are never overwritten.
The command reports read position, application bytes read, and OCR progress.
OCR failures and missing cue end times stop conversion before output creation.
Interrupting the process cancels file reads and the running OCR child. Tesseract
has a 60-second per-image timeout and a 1 MiB output limit. Image bytes travel
through a pipe, so no temporary-image cleanup is needed.

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
packaging. Node 22.23.4 and pinned Bun 1.4.4 are exercised locally on macOS; Linux
container execution remains an integration check. OCR output still needs human
comparison with the source images before treating it as accurate.

### First real-media check

The initial English SDH PGS track produced 342 SRT cues, with zero blank OCR
results. All 342 output start/end pairs matched the decoded PGS cues. The direct
reader returned 241,845,472 application-read bytes from a 9,789,595,171-byte MKV;
7,948,413 bytes were selected PGS payload. These are application counters, not
physical network traffic or a speed guarantee.

The revised buffer/PGM path produced identical raw OCR text for all 342 cues
against the original Skia/PNG run. Nearest-neighbor changed 14 cues and bilinear
changed 10, including new spelling errors, so the fixed Mitchell filter is retained.
RGBA composition differs from Skia by at most one channel level on this track;
this is measured OCR parity, not universal pixel parity.

The full command also ran under pinned Bun 1.4.4 on macOS with Tesseract 5.5.3:
342 SRT cues, zero blanks, all start/end pairs unchanged, including the final
25:29.403–25:30.404 cue. The English correction replaced 77 bars across the track.
The original six image samples plus six additional samples had seven such
character errors across five cues before correction and none after. No other
text differences were observed in those twelve samples; italic styling remains
unrepresented. This is bounded evidence, not a whole-track accuracy percentage
or complete Subtitle Edit parity. The original media remains unchanged.

### Worker integration notes (deferred)

A deployed worker needs native Tesseract and explicit language data in its image.
The apt-based image can install `tesseract-ocr tesseract-ocr-eng` with
`--no-install-recommends`. As a sizing reference, Debian's
[English data package](https://packages.debian.org/trixie/tesseract-ocr-eng)
is about 4 MiB installed; the executable, OCR library, orientation data and
missing shared libraries add more. Budget tens of MiB initially and measure the
actual image delta against the chosen base; this PR does not package an image.

The initial network-mounted scan took about 11m27s, while a warmed repeat of the
original command took 43.27 seconds. These observations are not controlled
benchmarks. [Issue #109](https://github.com/TacoRocket/tunarr/issues/109) tracks
reader window/read-ahead tuning and remains separate from this conversion.
Worker integration should reuse that reader work and the existing lookahead
admission budget rather than launch unbudgeted library OCR. Any reader change
must preserve the direct block timestamps and final stored duration verified here.

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
