# Subtitles without burning them into 4K video

**Subtitle preparation** gives Tunarr reusable text subtitles that the player can
draw separately, avoiding the extra video processing needed to burn in PGS.
It can help both direct playback and transcoded channels.

## Choose the playback path

If your player supports the source video, start with
[HLS Direct v2 on ErsatzTV Next](transcoding.md#hls-direct-v2-on-ersatztv-next).
It can copy compatible video instead of encoding it again. Separate text
subtitles do not themselves require video encoding. Selecting PGS does: Next
burns those images into the video. It does not send PGS to the player as a
separate image overlay, as a disc player or a direct-file player might.

Burning subtitles into a 4K source while keeping 4K output is a **4K-to-4K
transcode**. Every video frame still has to be decoded and encoded, even though
the resolution stays the same. The subtitle overlay adds work to that pipeline.
Preparing text removes that overlay work; a channel configured to transcode
still does its video decode and encode.

Tone mapping is a separate choice. It converts HDR brightness and colors to SDR;
4K resolution alone does not require it. With compatible HDR output and a
supporting player/display, Next can preserve HDR. With SDR output, an HDR source
needs conversion to keep its picture usable. An SDR source does not need HDR
tone mapping, even when both input and output are 4K. See the
[On, SDR fallback and Off settings](transcoding.md#hdr-tone-mapping-on-ersatztv-next).

## Turn on preparation

1. Enable subtitles on the channel and allow external English text in its
   subtitle preferences. Exclude image-based subtitles when you want prepared
   text to win over embedded PGS. A profile's language, title, forced and SDH
   filters still decide which track plays.
2. Enable **WebVTT Sidecar Subtitles** in the feature flags for separate HLS text
   delivery. Your player must support the HLS subtitle track.
3. Enable [automatic preparation](transcoding.md#automatically-prepare-upcoming-subtitles)
   through the FFmpeg settings API. The default `selected` mode follows channel
   preferences across streaming modes, including transcoded channels. The
   separate `all_english` option prepares English even when those preferences
   would not select it; it does not override playback selection.

For one program, use the [single-program task](transcoding.md#prepare-subtitles-for-one-program)
to inspect the result or resolve a track choice before scheduling it.

The current order is:

1. Reuse suitable text already in the media or a valid Tunarr cache.
2. Import an existing English SRT or ASS attached to the configured Plex library
   item. Automatic preparation does **not** search online subtitle services.
3. If suitable text is unavailable, convert an embedded English PGS track to SRT
   with the OCR worker.

Ambiguous Plex or PGS tracks return `needs-selection`; Tunarr does not guess.
A Plex error stops that program's job rather than silently choosing OCR.
The ladder has no Jellyfin acquisition or Bazarr adapter yet; existing usable
text from those libraries can still be reused.

OCR requires the Linux container and a locally accessible Matroska file. It reads
subtitle data directly from that file without remuxing the movie to SUP. The
one-time preparation cost belongs before airing; a valid completed cache skips
OCR on later airings. The six-hour lookahead helps, but late additions, ambiguity,
slow jobs and the work allowance can still leave a program unprepared at airtime.

## What changes for playback

On an Intel Core i3-1220P, separate cached text gave this 4K sample about **46%
more throughput with HDR output** and **55% more with SDR output** than PGS
burn-in. All four cases still encoded 4K video; these are not direct-copy speeds.

| Same 4K HDR source, 4K output | PGS burned into video | Cached text delivered separately |
| --- | ---: | ---: |
| Preserve HDR | 1.86× | 2.72× |
| Convert to SDR | 1.03× | 1.60× |

**1× means processing video as fast as it plays.** SDR with burn-in was only just
above that mark in this sample. Text preparation gave it more room, but short
measurements do not establish sustained channel capacity or guarantee smooth
playback on a particular client.

The source is Dolby Vision profile 7 with an HDR10 base. It correctly uses Next's
existing libplacebo tone mapper for SDR, even with the optional LUT requested.
The HDR10-only LUT was **not** used, so this table does not measure the LUT port's
benefit. HDR output here means preserving the HDR10 base, not retaining Dolby
Vision enhancement data through the encode.

These are playback costs after a text subtitle is ready. Preparation is a separate
job: an earlier English PGS conversion of *A Charlie Brown Christmas* took about
106 seconds for 342 cues, then a repeated request reused its cache without OCR.
That is one title on one machine, not a conversion-time estimate for a feature
film. The four-case playback comparison reuses a previously acquired SRT; it does
not measure OCR of that movie or establish whole-movie subtitle accuracy.

<details>
<summary>Test setup and full numbers</summary>

Measured November 1, 2026, with the released ErsatzTV Next
[`v0.2.4-trfork.11`](https://github.com/TacoRocket/next/releases/tag/v0.2.4-trfork.11)
Linux x64 worker and packaged FFmpeg `8.1.2-etv.dev.a64ee856`.

- Source: *Braveheart* (1995), 3840×2160 HEVC, 24000/1001 fps, starting at
  02:25:17.930. The embedded PGS canvas is 1920×1080 and is scaled for the 4K
  overlay. The text cases use a previously acquired SRT.
- Output: 3840×2160 HEVC VAAPI, low-power encoding, 15 Mbps target/maximum,
  30 Mbps buffer; AAC stereo at 192 kbps. HDR uses 10-bit output and tone mapping
  Off; SDR uses 8-bit output and tone mapping On. No CRT shader or watermark.
- Each case encoded the same 719 frames from a 30-second excerpt, twice, with
  the second pass in reverse order. Speeds below use encoded duration divided
  by mean FFmpeg wall time. HDR versus SDR changes output bit depth as well as
  tone mapping; it is not a measurement of the mapper alone.
- An existing background camera process using QSV remained running throughout.
  Other benchmark jobs were excluded with the shared test lock. This was a
  matched comparison under normal background load, not an idle-GPU test.

| Output and subtitles | Run 1 | Run 2 | Mean processing time |
| --- | ---: | ---: | ---: |
| HDR + PGS burn-in | 1.814× | 1.910× | 16.113 s |
| SDR + PGS burn-in | 1.030× | 1.035× | 29.046 s |
| HDR + cached text | 2.716× | 2.717× | 11.039 s |
| SDR + cached text | 1.599× | 1.596× | 18.768 s |

The actual released worker generated each pipeline. A separate unpaced FFmpeg
replay kept its decode, filter, audio, encoder and HLS output options; only timing,
logging and output filenames changed. The timed numbers include HLS video muxing
but exclude the worker's WebVTT writer, Tunarr HTTP delivery and player decoding.

Separate worker runs produced HLS output for all four cases. Decoding a segment
from each succeeded; probes confirmed 10-bit PQ for HDR and 8-bit BT.709 for SDR.
The text cases emitted WebVTT cues matching the source SRT timing, with no PGS
overlay in their video commands. No hardware fallback was reported. This run
did not repeat the earlier Tunarr HTTP transition checks or test TiviMate/UHF.

</details>

## Keep in mind

- **Wording and styling:** OCR can misread words and loses PGS positioning and
  artwork. Imported ASS remains intact in the cache, but WebVTT cannot reproduce
  its full typesetting, animation or karaoke. Burn-in remains useful when that
  appearance matters more than throughput.
- **Joining mid-line:** Next includes the remaining part of an active cue in its
  WebVTT output. A diagnostic AVPlayer client skipped that first line during
  startup; this has not established TiviMate or UHF behavior. Later cues retained
  their timing. See the [playback limits](transcoding.md#subtitles-in-direct-hls-v2).
- **Reuse and retention:** an acquired copy survives Plex rescans and stays while
  its program is in the library or recoverable Trash. Deleting the program or
  emptying Trash makes it eligible for cleanup. Replacement media invalidates
  stale results. Keep Tunarr's cache on persistent storage.

We added preparation so smaller servers can spend less of their playback budget
drawing subtitles into every frame. It gives users a choice between the original
subtitle appearance and cheaper separate text delivery.
