# Subtitle preparation

## Acquired subtitle cache

`SubtitleCache.ts` implements a file-backed cache with source-fingerprint manifests.
Plex acquisition uses `PlexSubtitleAcquisition.ts` for search, asynchronous fetch,
download and selection restoration, and the existing `ExternalSubtitleDownloader`
for writing the SRT. The `prepare-plex-subtitle` CLI requires an explicit result
title, one media version and one part. No OCR or provider ladder runs here.

Acquired SRT files and their manifests live under `acquired/<hashed-program-id>`.
The manifest records provider, language, forced/SDH flags, program ID and source
identity; only a matching manifest and file are admitted to playback. An incomplete
cache write is retried. `admitAcquiredSubtitleCache` rechecks the source before
writing the manifest and removes the downloaded SRT if that identity changed.
`ProgramStreamDetailsFetcher` prepends valid acquired tracks
to the existing selection inputs without inserting scanner-owned subtitle rows.
Metadata rescans therefore cannot delete them through sidecar-row replacement.

These copies follow library membership: `ok` and `missing` (Trash) keep them even
without scheduling references. Only removal of the program record, including
emptying Trash, allows the existing sweeper to remove them. Retention does not
transfer ownership to a different program ID during Trash repair.
Embedded-extraction retention is unchanged. Local source replacement is
detected through file stat identity; remote replacement depends on scanned identity.
Plex restoration is verified on success. A failed/interrupted asynchronous fetch
can outlive the command, so failure does not guarantee restoration.

## Selective Matroska subtitle extraction

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

The standalone script remains available for local conversion. The Linux container
also exposes the explicit `prepare-pgs-subtitle` cache job described below. Neither
path schedules library-wide OCR. OCR output still needs human comparison with the
source images before treating it as accurate.

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

### OCR-to-cache process

`PgsSubtitlePreparation.ts` owns source identity, reuse and cache admission.
The manifest origin `pgs-ocr` records stream index, English language, forced/SDH
flags and recipe version 1. The cache key includes these fields and source identity.
Changing the recipe can invalidate reuse explicitly; an installed Tesseract update
alone does not invalidate already generated subtitles.

The `prepare-pgs-subtitle` command submits a `pgs-ocr` request through
`IWorkerPool`. `TunarrWorkerPool.ts` uses bulkhead isolation: the configured
scheduling slots plus one exclusive, on-demand OCR slot. Scheduling is never
assigned to the OCR slot, so terminating unresponsive OCR cannot reject a
scheduling request. With `TUNARR_WORKER_POOL_SIZE=1`, at most two worker threads
run while both roles are active. One OCR request is admitted per pool; another
reports busy rather than sharing the worker. An idle OCR worker retires after
the configured idle timeout, or 60 seconds when scheduling idle retirement is
disabled. Its replacement starts only when another OCR request arrives.

This replaces the dedicated OCR process bundle; the standalone command starts
its own instance of the shared pool machinery, not a connection to an already
running server. With scheduling workers disabled, `NoopWorkerPool` keeps
scheduling inline but still delegates OCR to the exclusive worker. It does not
start unused scheduling threads. Automatic lookahead and provider fallback
remain future work.

Cancellation is identified by request ID. Responsive OCR aborts reads and signals
its native Tesseract child, escalating from TERM to KILL after five seconds. The
normal reply waits for child exit and temporary-directory cleanup. If no reply
arrives within 30 seconds of cancellation, the pool rejects the request and
terminates only the OCR worker. The same grace applies to explicit cancellation
and the CLI's 30-minute deadline. The retiring slot cannot accept another job;
a replacement is allowed only after the old thread exits. This bounds the caller's
wait, not the completion of an operating-system read stuck in the kernel.
Hard termination may leave temporary files for the locked cleanup described below.
Scheduling deadlines retain their existing worker-termination behavior. Pool
shutdown cancels OCR before terminating workers. Search starts when a scheduling
request needs it, so OCR alone does not require a running search service.

`PgsOcrProcess.ts` uses two existing util-linux primitives. `flock --no-fork`
holds an advisory kernel lock through a small child process for one conversion
per local cache; another conversion reports busy, while an already completed
cache hit remains reusable. `setpriv --pdeathsig SIGKILL` binds the lock holder and
Tesseract to the creating worker thread's lifetime. No privilege change is made.
This spawning-thread behavior was validated on Bun 1.4.4; recheck it on Bun
upgrades, since a runtime that spawns through a short-lived helper thread could
kill the native child unexpectedly.
This also stops native work when that thread or its containing process dies hard;
normal cancellation additionally waits for the native process to be reaped.

Conversion writes into a unique `.pgs-ocr-*` temporary directory; only a successful
result is moved to the acquired cache and admitted after the source recheck.
Handled failures/cancellation remove the directory. A hard kill or power loss can
still leave one behind. The next OCR request or existing startup/hourly subtitle
cache maintenance removes abandoned directories under the same lock, skipping
cleanup while a conversion owns it. Completed cache entries are not swept by this
temporary-directory cleanup. Source replacement still rejects reuse. Track labels
come from the selected track for forced status and the explicit `--sdh` choice,
since scanned metadata does not currently preserve SDH reliably.

The container retains Tesseract 5.5.3 and English `tessdata_fast` 4.1.0 data, with
both downloads pinned by `docker/tesseract.sha256`. No OCR recipe, cache format,
retention rule or playback timing changes in the worker migration.

The exclusive-slot correction was checked on Linux/Bun 1.4.4 with the pinned
5.5.3 engine and a one-worker scheduling setting. The same 342-cue track retained
byte-identical SRT output and cache reuse. A probe blocked the OCR thread's
JavaScript loop while native Tesseract was stalled: the 30-second cancellation
backstop terminated that worker, stopped native work, and left the scheduling
worker alive. The abandoned directory was reclaimed under the lock and a new
OCR worker returned the cached subtitle. Scheduling used the real random scheduler
with an empty-program fixture and controlled input collection, not a full-library
throughput test.

A second probe blocked a file open on a named pipe and ignored cancellation.
The request rejected after its deadline plus the 30-second grace. Bun did not
finish worker exit until the probe released the blocked operation. The pool
refused another OCR request during that interval, scheduling survived, and only
then did an on-demand replacement reuse the cache. This demonstrates bounded
request failure and isolation, not guaranteed recovery of a stalled NAS read.
With scheduling workers disabled, actual CLI cache reuse started only the OCR
worker, with no scheduling threads. Playback was not rerun for this migration;
the earlier WebVTT evidence and its in-progress cue limitation below remain the
playback boundary.

The first Linux container check used Bun 1.4.4 and packaged Tesseract 5.3.4.
It produced 342 SRT cues with zero blanks; all timing pairs, including the final
cue, matched the earlier direct-PGS result. There were text differences in 21
cues compared with macOS Tesseract 5.5.3, including both corrected and introduced
recognition errors. This establishes functioning OCR, not text parity or complete
accuracy. A repeated request returned `cached` without changing file bytes or
mtime. Cancellation during active Tesseract processing left no worker/native OCR
process, temporary output directory or admitted subtitle; a concurrent request
reported busy. A 65-second regular-HLS mid-program AVPlayer probe delivered 21
captions matching the generated SRT, a constant source-to-item timing offset,
zero stalls and no reported playback errors. Other clients and full-film viewing
remain unverified. These probes used an isolated runtime image with the candidate
bundles and the initial distro-provided OCR packages; no production cutover occurred.

A fresh-cache Linux 5.5.3 comparison then reproduced the saved macOS 5.5.3 SRT
byte-for-byte: all 342 cue texts and timing pairs matched, eliminating the 21
text differences. English traineddata was byte-identical in all three runs.
Linux used Leptonica 1.82.0 and macOS 1.87.0, on different CPU architectures.
The pinned Docker build stage and runtime copy steps were then exercised in an
isolated image: the statically linked Tesseract executable again produced the
same SRT bytes, and a repeated request reused the unchanged cache file.
This demonstrates parity for this sample, not complete recognition accuracy:
the matching output still contains OCR errors. Existing cached subtitles remain
reusable; changing the engine pin does not force them to be regenerated.

The initial network-mounted scan took about 11m27s, while a warmed repeat of the
original command took 43.27 seconds. These observations are not controlled
benchmarks. [Issue #109](https://github.com/TacoRocket/tunarr/issues/109) tracks
reader window/read-ahead tuning and remains separate from this conversion.
Future automatic scheduling should reuse that reader work and the existing lookahead
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
