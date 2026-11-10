# 2026.11.2-trfork.1

Upstream Tunarr 2026.11.2, plus the fork's work since 2026.11.0-trfork.1. The headline changes are channels generated from seeds, an early beta of extensions with an optional login set up from the web app, and Spelunkr live feeds. New channels made in the web app now use the ErsatzTV next backend. This release changes the database four times, removes two settings and moves the container from Bun to Node, so read [Before you upgrade](#before-you-upgrade) first.

## New

- **Channels generated from seeds.** Under Programming → Add → **Generate from seeds…**, pick up to ten shows, episodes or movies and Tunarr builds a lineup of related programs from their genres, tags, cast, director, studio and year. Keep it as a one-time lineup, let it **grow as you watch** (it adds a related program after each recorded play once less than 12 hours are left), or use a **rolling guide** that keeps about 6 hours ahead and refills itself every 5 minutes. The **Balanced** mode mixes what you are watching now with a little discovery. Recommendations weigh how much of a program was actually watched, and each picked item says why it was picked. Semantic matching uses a similarity extension such as Potion when one is installed and ready; without one, Tunarr matches on metadata. Saving a generated lineup moves its channel to ErsatzTV next. [Seed channels](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/scheduling.md) (#202, #203, #206, #208, #209, #215, #216, #238)
- **Extensions, early beta.** Settings → Extensions installs extensions from a public GitHub source and runs them in a sandbox that can only reach the service you configure for them. The first ones are Bazarr, which fetches subtitles Tunarr is missing, and Potion, which finds similar titles for seed channels. Installing and managing extensions needs a login, or `TUNARR_EXTENSION_TRUSTED_LAN=true` on a network you trust. [Extensions](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/extensions.md) (#219, #224, #229, #233, #235)
- **A login you can set up from the web app.** Settings → Extensions → **Set up administrator access** creates a Tunarr login without editing environment variables. It works the same way as the `TUNARR_BASIC_AUTH_*` variables: it protects the same pages and leaves the same ones open (playlists, XMLTV, streams, HDHomeRun and images). The one-time setup code is printed in the log and written to `setup-code.txt` in the Tunarr data folder. If the environment variables are set, they take precedence. [Administrator access](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/extensions.md) (#236)
- **Spelunkr live feeds.** A channel can follow a Spelunkr feed, chosen while you create the channel or later under Streaming → **Configure live feed**. The guide shows program names 12 hours ahead, and everyone watching shares one update check every 5 minutes. Needs HLS on ErsatzTV next. [Live relay](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/live-relay.md) (#193, #200, #201, #204)
- **Subtitle delivery per channel.** Channel → Streaming → Audio & Subtitles can burn subtitles into the picture, send them as separate WebVTT, or follow the global default in Settings → Features → **Sidecar Subtitles by Default**. (#199)
- **Plex change notifications in Settings.** Settings → Media Sources → **Refresh libraries when Plex reports changes** turns Plex notifications on or off without an environment variable. (#213)
- **Stream selection profiles** (from upstream): audio and subtitle choice rules for a channel, Custom Show or filler list. (#210)
- **From upstream Tunarr 2026.11.2** (#239):
  - bulk actions, keyboard navigation and a status filter on the Channels page, which now shows cards or a table;
  - bulk edits of filler lists and channel assignments;
  - **Remove schedule** for a channel saved from a slot editor, keeping its lineup;
  - a fallback soundtrack you can upload, which loops under the offline picture;
  - separate watermark fade and time limit settings;
  - a message linking to the logs when a request fails.

## Fixed

- **7.1 FLAC programs now start** on HLS Direct v2 and HLS remux channels. Their audio is downmixed to 5.1 AC-3 at 640 kbps; DTS and TrueHD get the same 6-channel limit. Compatible tracks are still copied. (#214)
- **Saving a channel keeps its on-demand position** and schedule clock (from upstream). (#239)
- **Library scans** (from upstream): a program that returns after being moved to the trash is restored, seasons and albums with nothing left go to the trash, show IDs from `tvshow.nfo` are kept, and movie artwork matching is stricter. (#239)
- **Custom FFmpeg builds** no longer get a full capability dump at every start. Tunarr records the bundled FFmpeg build and warns once when it sees a different one. (#212)

## Experimental: ErsatzTV next backend

- **Steady SDR color on VAAPI**, as Tunarr's own pipeline already has: 8-bit SDR output is converted to limited-range BT.709 at the end of each program, which stops some players from freezing on the last picture at a program boundary. HDR, Dolby Vision, 10-bit, copied video and software encoding are unchanged. (#239)
- **New channels made in the web app use ErsatzTV next**, with a transcode profile picker that only lists profiles it can play. The global switch in Settings → Features and `TUNARR_ERSATZTV_NEXT_ENABLED` are gone. See [Before you upgrade](#before-you-upgrade). (#217)
- **Credit ads can use an episode's ending chapter**, so the episode's own picture and sound come back for a preview or post-credits scene. [Credit squeeze](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/credit-squeeze.md) (#223)
- **A dropped live feed shows the channel's offline picture** instead of a black screen with error text. (#195)
- **Keep the source aspect ratio**, so a 4:3 program fills a 4:3 display and widescreen players add their own bars. Off by default; set `nextPreserveSourceAspect` on a transcode profile through the API. [Transcoding](https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/transcoding.md) (#196)
- **`TUNARR_VAAPI_DEFAULT_SCALING=1`** now also applies to ordinary video and image subtitles on ErsatzTV next. (#192)

## Under the hood

- **Upstream Tunarr 2026.11.2** is merged in. (#210, #239)
- **Tunarr runs on Node 22.23.4 instead of Bun.** The Node download is checked against a pinned SHA-256 hash when the image is built. (#232)
- **FFmpeg runtime 8.1.2-trfork.3** ([ErsatzTV-ffmpeg `92283823`](https://github.com/TacoRocket/ErsatzTV-ffmpeg/commit/9228382361ac1372d144f7ba56b996b5579f6137)): upstream ErsatzTV-ffmpeg 8.1.2-8 fixes (for example, a hardware-decoded file whose color tags change partway no longer stops the stream), native NV12 output at supported sizes, and readable ASS captions in WebVTT output, which keep positioned titles and drop drawn karaoke fragments.
- **ErsatzTV next worker [v0.2.5-trfork.2](https://github.com/TacoRocket/next/releases/tag/v0.2.5-trfork.2)**, up from v0.2.4-trfork.14. Its download is checked against a pinned SHA-256 hash when the image is built.

## Before you upgrade

- **Four database changes.** On first start, Tunarr adds a source-aspect option to transcode profiles, a subtitle delivery setting to channels, stream selection profiles for Custom Shows (from upstream), and watch-time columns to play history. Older images refuse a database with these changes. To be able to go back, stop Tunarr and copy your Tunarr data folder first; going back to 2026.11.0-trfork.1 means restoring that copy.
- **ErsatzTV next switch removed.** If you used `TUNARR_ERSATZTV_NEXT_ENABLED` or the Settings → Features switch, Tunarr copies that choice onto each HLS, HLS Direct v2 and MPEG-TS channel it applied to on first start, so those channels keep playing the same way. You can then remove the variable. Saving a channel whose playback engine can't play its transcode profile now shows what to change instead of saving. (#217)
- **`TUNARR_WEBVTT_CHANNEL_ID` removed.** Use the channel's subtitle delivery setting instead. `TUNARR_WEBVTT_SIDECAR_ENABLED` still sets the global default. (#199)
- **Subtitle preferences become stream selection profiles** (from upstream). If you had different forced or default rules for different languages, check the converted profile: the first language's rules now apply to every language. Your original settings are kept. [Upstream's notes](https://github.com/chrisbenincasa/tunarr/blob/cfcd5184cbb162c505f61bf0464091c85d488e8d/docs/configure/stream-selection.md#upgrading-from-earlier-versions) (#210)
- **Plex notifications:** once you change the switch in Settings, your choice wins over `TUNARR_PLEX_NOTIFICATIONS`. (#213)
- **API change** (from upstream): `GET /api/media-libraries/:libraryId/programs` now returns pages (`total`, `result`, `size`, `offset`; 100 per page by default, up to 1000). Scripts that read it need to page through it.
- Same search index (Meilisearch 1.52.4) as 2026.11.0-trfork.1.
