# 2026.10.4-trfork.10

Subtitles that are ready before the show starts, clearer reports when a channel quietly falls back, and a first look at credit squeeze.

## New

- **Fallback reports cover much more.** The sessions API already said when Tunarr keeps a channel on the air by doing something other than what you configured. Now it also says when hardware decoding, encoding or HDR tone mapping fell back to the CPU, and when passthrough had to leave out an image subtitle it can't show. Plain MPEG-TS and HLS Direct v1 streams report too, and two people watching the same channel each get their own report. [Live fallback reports](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#live-fallback-reports) (#105, #108, #112)

## Fixed

- **Subtitles are ready before the show starts.** Tunarr now prepares the text subtitles your channels need for the next six hours, earliest airing first, instead of scrambling an hour ahead. For MKV files it reads just the subtitle parts and skips the video and audio, instead of reading the whole file. Preparation is capped at ten minutes of work per hour, apart from anything airing within the hour, so it can't take over your disks. [Subtitle extraction](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/transcoding.md#subtitle-extraction) (#104)
- **The web page and the server agree on the version.** After an update, the web page could show an older version number than the server, along with a mismatch warning that refreshing didn't fix. (#107)

## Experimental

- **Credit squeeze.** When a movie or episode reaches its final credits, the picture shrinks into a box over a background image you choose while the credits keep playing, the way TV makes room to promote what's next. Off by default and set per channel through the API. It needs VAAPI encoding with hardware filters, and it can't be combined with skipping the end credits. A layout template helps you make the background. [Credit squeeze](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/credit-squeeze.md) (#96, #113)

## Under the hood

- The publish workflow now reuses an already-published FFmpeg runtime instead of rebuilding it. (#125)
- The search engine update (#87) shows up in the full list below because trfork.9 shipped it from a release branch. Nothing new there.

## Before you upgrade

- **Back up your Tunarr data folder first.** This release adds a database change for credit squeeze. Going back to trfork.9 needs the backup you took before upgrading; the older image can't use the upgraded database.
- **Subtitles get prepared again.** Subtitle files Tunarr extracted before this release are prepared once more as they come up, within the ten-minute hourly cap, so expect a little extra disk reading for the first day.
- Same search index and FFmpeg runtime as trfork.9.
