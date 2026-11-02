# 2026.11.0-trfork.1

Upstream Tunarr 2026.11.0, plus the fork's work since trfork.12. Most of that work is on the experimental ErsatzTV next backend, which stays off until you turn it on. Other new features are off by default too; the fixes and the upstream changes apply to everyone.

## New

- **Subtitles prepared ahead of time.** Tunarr can look six hours ahead in the guide and get English subtitles ready for what's coming up. It uses text already in the file, imports subtitles attached in Plex, Jellyfin or Emby, and falls back to OCR of PGS image subtitles. Off by default; turn it on through the FFmpeg settings API. [Automatically prepare upcoming subtitles](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#automatically-prepare-upcoming-subtitles) (#145, #147, #155, #167, #184)
- **Toonami live feeds in the web app.** Pick a Toonami Aftermath feed in a channel's Streaming settings instead of calling the API. The guide now shows the feed's real schedule, with show names and times, instead of placeholder blocks. [Toonami live relay](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/live-relay.md) (#144, #185)
- **Playback engine choice.** A channel's Streaming tab has a **Playback engine** setting, Tunarr or ErsatzTV next, shown separately from stream mode. (#172)
- **Plex changes between scans.** Set `TUNARR_PLEX_NOTIFICATIONS=true` to import Plex changes as they happen, between your normal scans. Off by default. [Configuration](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/configuration.md) (#159, #164, #170)
- **From upstream Tunarr 2026.11.0:**
  - the ErsatzTV next version in the Help menu;
  - local libraries move a season, show, album or artist to the trash along with its last item;
  - music tracks fall back to the album's art when their own art can't be reached. (#197)

## Fixed

- **One slow player no longer freezes an HLS channel for everyone** (from upstream). A player that falls more than about 80 seconds behind live, for example after a long pause, now has to rejoin at the live point instead of resuming where it stopped. (#197)
- **Subtitled HLS channels that wouldn't start.** Tuning in to a regular HLS channel with sparse subtitles could fail with an error after about 16 seconds. It now starts as soon as the video is ready. (#166)
- **New Plex movie subtitles** are picked up by a normal scan. (#158)
- **CRT looks on channels that aren't 1080p.** DVD Broadcast on HDR10 programs and the Experimental tier's color sampling now apply at the channel's own size, such as 720p or 4K. Before, those channels quietly used the plainer path. (#162, #165)
- **Slot padding** lines up with your local clock instead of UTC (from upstream). (#197)
- **The Tunarr Retuned logo** shows again in the header and welcome page. (#153)

## Experimental: ErsatzTV next backend

Still off by default. A channel on it now keeps much more of what Tunarr's own pipeline does, including the fork features trfork.12 dropped there:

- **Every CRT look**, with its extras and processing tier, including DVD Broadcast on HDR10 programs. [CRT on ErsatzTV next](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/crt.md#on-the-ersatztv-next-backend) (#151, #152, #156, #160)
- **VAAPI low power.** (#150)
- **Credit squeeze**, and optionally ads that play during the final credits, chosen through the channel API. [Credit squeeze](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/credit-squeeze.md#on-the-ersatztv-next-backend) (#176, #180)
- **Direct play on HLS Direct v2 channels** where the source allows it, copy audio profiles, and surround kept up to 5.1 when audio has to be re-encoded. 10-bit H.264, which most players can't decode, is re-encoded. [HLS Direct v2 on ErsatzTV next](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#hls-direct-v2-on-ersatztv-next) (#173, #177, #181)
- **The Toonami live relay**, which can also pass the feed through on HLS Direct v2. (#149, #186)
- **HDR tone mapping choices:** On, SDR fallback or Off, in Settings → FFmpeg and per transcode profile. [HDR tone mapping on ErsatzTV Next](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#hdr-tone-mapping-on-ersatztv-next) (#175)
- **Clearer sessions:** the sessions API now says when the worker fell back (for example, to the CPU) or couldn't show subtitles. (#161, #163)
- **Fixed:** programs whose length wasn't a whole number of milliseconds played an error screen. (#174)

## Under the hood

- **Upstream Tunarr 2026.11.0** is merged in. (#197)
- **The image now includes the fork's build of the ErsatzTV next worker,** [v0.2.4-trfork.14](https://github.com/TacoRocket/next/releases/tag/v0.2.4-trfork.14), in place of upstream's v0.2.3. Its download is checked against a pinned SHA-256 hash when the image is built.
- **4:3 shows on the CRT look** skip an extra conversion step on the faster tiers. (#154)

## Before you upgrade

- **One database change.** On first start, Tunarr adds an ErsatzTV next tone-mapping setting to each transcode profile. It's empty, so profiles follow the app-wide default, On. Older images refuse a database that has this change. To be able to go back, stop Tunarr and copy your Tunarr data folder first; going back to trfork.12 means restoring that copy.
- **One longer Plex movie scan.** The first normal Plex scan after upgrading re-reads every movie once, so it can pick up subtitle changes. On our test server, 1,418 movies took about 2 minutes. Later scans are back to normal. (#158)
- Same search index (Meilisearch 1.52.4) and FFmpeg runtime as trfork.12.
