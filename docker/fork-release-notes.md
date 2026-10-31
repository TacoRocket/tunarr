# 2026.10.4-trfork.11

Build a classic TV block in one request, subtitles that stay in time when you tune in mid-show, and a way to keep a subtitle Plex found for you.

## New

- **Scheduling presets.** One API request turns a familiar TV pattern into an ordinary Random Slots schedule that you can still edit before saving: **Marathon** (four episodes of each show in a row), **Primetime** (two), **Saturday Morning** (one), or **Variety** (two episodes of one show, then two shuffled picks from a Custom Show or Smart Collection). You can add an ad pod after every program. Variety can also take its shows from a Smart Collection, playing each show's matching episodes in order. API only for now; the web UI waits for upstream's redesign. [Show scheduling presets](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/scheduling.md#show-scheduling-presets) (#115, #123)

## Fixed

- **Subtitles stay in time when you tune in mid-show.** On regular HLS streams, tuning in while a subtitle line was on screen could throw every line after it out of time. Now the line already showing is skipped and the rest arrive on time, the way Direct HLS v2 already behaved. (#122)

## Experimental

- **Keep a subtitle that Plex finds for you.** For one program at a time, a command asks your Plex server to search for English SRT subtitles, fetches the one you pick, and keeps a copy in Tunarr's cache, so library rescans don't lose it. Your subtitle preferences still decide what plays. English only, one media version per item, and no web UI yet. [Fetch an English subtitle from Plex](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#fetch-an-english-subtitle-from-plex) (#121)

## Under the hood

- **Groundwork for turning image subtitles into text.** A developer script converts one PGS track in an MKV into an SRT file with Tesseract OCR. It runs from a source checkout with Tesseract installed; the container doesn't include Tesseract, and nothing runs it automatically yet. (#110)
- **The image is built with pnpm 12.15.0 and Turbo 2.11,** taken from upstream as its own change. Rebuilding the lockfile also moved a few small shared libraries to newer minor versions (ajv for format checks, ts-pattern, debug). It isn't in the list below because it was cherry-picked onto the release branch. (#137)
- Testing guidance for fork contributors. (#129)

## Before you upgrade

- **No database change this time.** Going back to trfork.10 is a plain image swap.
- Same search index and FFmpeg runtime as trfork.10.
