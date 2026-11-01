# TacoRocket fork docs

Welcome! This is everything the fork adds on top of [Tunarr](https://github.com/chrisbenincasa/tunarr). For anything else (setting up channels, libraries, the guide), use [Tunarr's own docs](https://tunarr.com/). The fork works the same way there.

**New here?** Start with the [Quick Start](../../README.md#quick-start) to get the fork running, then come back and pick something fun.

## Things to try

| Feature | What it does | Guide |
| --- | --- | --- |
| 📺 **CRT looks** | Scanlines, glow and a softer broadcast picture, per channel. Five looks, from a light touch to full late-night TV. | [CRT looks](crt.md) |
| 📼 **After-show ad pods** | A real commercial break after each show: a bumper, a couple of ads, a station ID. | [Scheduling](scheduling.md#after-show-ad-pods) |
| 🎬 **Skip the end credits** | The channel moves on when the final credits start, like TV does. | [Scheduling](scheduling.md#skip-the-end-credits) |
| 🎞️ **Credit squeeze** | Keep final credits and their audio playing over a channel background, without ending the program early. | [Credit squeeze](credit-squeeze.md) |
| 🗂️ **Filler from a saved search** | Point a filler list at a Smart Collection, and new commercials show up on their own. | [Scheduling](scheduling.md#filler-lists-from-a-smart-collection) |
| 🕒 **Offset channels** | Mirror a lineup at the same time or a few hours later, with an optional independent CRT look. | [Scheduling](scheduling.md#offset-channels) |
| 🧹 **Repair re-added items** | When Plex re-adds a show under a new ID (an upgraded file, a library rebuild), channels and watch history move to the new copy instead of the Trash blanking them. | [Repair re-added items](trash-repair.md) |
| ⚡ **Hardware options** | Run more 4K HDR channels on a small Intel box. | [Hardware comparison](hardware-comparison.md) |
| 💬 **Prepared subtitles** | Reuse text or convert PGS ahead of airing, so HLS players can show subtitles without burning them into 4K video. | [Subtitle preparation](subtitles.md) |

Most fork features don't have buttons in the app yet; you switch them on with a short command. Each guide gives you one to copy and paste. Buttons will come once Tunarr's new settings pages land.

## For tinkerers

- [Toonami live relay draft](live-relay.md): an isolated experiment with selectable network feeds and paced outage recovery.

- [Credit squeeze artwork template](credit-squeeze-artwork.md): downloadable layout guides for the proposed still-image squeeze in PR96.
- [Container and releases](container.md): what's in the image, GPU options, versions and rollback.
- [Transcoding settings reference](transcoding.md): low-power encoding, scaling, the HDR LUT, and the fine print.
- [Server settings](configuration.md): environment variables the fork changes.

## Something broken?

[Open a fork issue](https://github.com/TacoRocket/tunarr/issues). Please don't report fork problems to upstream Tunarr. If the same thing happens on a regular Tunarr build, then it's upstream's bug, and you can report it [there](https://github.com/chrisbenincasa/tunarr/issues).
