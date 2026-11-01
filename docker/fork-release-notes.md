# 2026.10.4-trfork.12

A new name, the latest upstream Tunarr, and several new tools that stay off until you turn them on. Your channels play the same as they did on trfork.11.

## New

- **Tunarr Retuned.** The web app shows the fork's own name and a refreshed TV logo in the header, browser tab and welcome page, so it's clear which build you're running. Your channels' default icons and watermarks are unchanged. (#134)
- **From upstream Tunarr:**
  - a setup checklist on the welcome page that you can skip;
  - bulk flex tools gathered into a **Flex** menu;
  - channel edit tabs that stay loaded as you switch between them. (#141)

## Fixed

- **The guide right after a restart.** Guide lookups now wait for the first full guide build, instead of briefly showing gaps for channels it hasn't reached yet. (#142)
- **Plex items whose video stream reports no size** are accepted instead of failing. (#141)
- **Channel icon URLs with stray spaces** now load. (#141)
- **Software-encoded error and offline screens** now show a steady picture with their sound, instead of a single frame. (#128)

## Experimental

- **ErsatzTV next streaming backend (from upstream).** A separate worker program from the ErsatzTV project can transcode a channel instead of Tunarr's own FFmpeg pipeline. It's **off by default**: turn it on per channel, or for every channel with `TUNARR_ERSATZTV_NEXT_ENABLED`.
  - Fork picture features don't apply on a channel that uses it: the CRT look, credit squeeze and VAAPI low power. The session log and the Stream Troubleshooter say so.
  - [ErsatzTV next backend](https://github.com/TacoRocket/tunarr/blob/main/docs/configure/ffmpeg/ersatztv-next.md) (#141)
- **Live relay.** An empty HLS channel can relay a Toonami Aftermath feed through its normal transcode profile. It's set per channel through the API, with no web UI yet. [Toonami live relay](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/live-relay.md) (#128)
- **Text subtitles from PGS images.** A command converts one English PGS subtitle track to text with OCR and keeps the result in Tunarr's subtitle cache. It runs one job at a time in its own worker, so scheduling isn't affected. [Prepare an English PGS subtitle with OCR](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#prepare-an-english-pgs-subtitle-with-ocr) (#131, #139)
- **Fewer Plex requests during library scans.** Set `TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE=20` to fetch movie and episode details in groups. Unset, scans work as before. [Plex scan batching](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/configuration.md#plex-scan-batching) (#34)

## Under the hood

- **Upstream Tunarr `main` as of October 31** is merged in. (#141)
- **The image now includes:**
  - Tesseract 5.5.3 with English recognition data, for the OCR command (#131);
  - the ErsatzTV next worker v0.2.3, about 11 MB (#141).

  Both downloads are checked against pinned SHA-256 hashes when the image is built.
- **Server tests now run on Bun,** the runtime the image uses, with a small remainder on Node. (#140)

## Before you upgrade

- **One database change.** On first start, Tunarr adds an ErsatzTV next setting to each channel, off for all of them. Older images refuse a database that has this change. To be able to go back, stop Tunarr and copy your Tunarr data folder first; going back to trfork.11 means restoring that copy.
- Same search index (Meilisearch 1.52.4) and FFmpeg runtime as trfork.11.
