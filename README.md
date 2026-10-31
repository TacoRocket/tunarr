<p align="center">
  <img src="./design/tunarr-guide.png" alt="Tunarr TV Guide">
</p>

<h1 align="center">Tunarr — TacoRocket's fork</h1>

<p align="center">Create your own live TV channels from media on Plex, Jellyfin, Emby, or local files.</p>

<p align="center">
  <a href="https://github.com/chrisbenincasa/tunarr/releases"><img src="https://img.shields.io/github/v/release/chrisbenincasa/tunarr?style=flat&logo=github&color=lightseagreen&label=upstream%20release" alt="Upstream Release"></a>
  <a href="https://github.com/TacoRocket/tunarr/pkgs/container/tunarr"><img src="https://img.shields.io/badge/fork%20container-GHCR-lightseagreen?style=flat&logo=docker" alt="Fork Container"></a>
  <a href="https://github.com/chrisbenincasa/tunarr/stargazers"><img src="https://img.shields.io/github/stars/chrisbenincasa/tunarr?style=flat&logo=github&color=lightseagreen" alt="GitHub Stars"></a>
  <a href="https://discord.gg/7tUjBbDxag"><img src="https://img.shields.io/discord/1254564006123802805?style=flat&logo=discord&logoColor=white&label=Discord" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Zlib-lightseagreen?style=flat" alt="License"></a>
</p>

---

## Daily library scan time

To run automatic library scans around 3 a.m. Central time, set both environment variables and restart Tunarr:

```yaml
environment:
  TUNARR_LIBRARY_SCAN_DAILY_TIME: "03:30"
  TUNARR_LIBRARY_SCAN_TIME_ZONE: "America/Chicago"
```

This overrides `rescanIntervalHours` for library scans only. Channel schedules, collection and custom-show sync, hourly library refresh, and the container timezone keep their existing behavior. Manual scans remain available. Prefer `HH:30` (for example, 03:30 Chicago with a UTC container) to retain the existing half-hour separation from the hourly library refresh. Any valid `HH:mm`, including 03:00, is supported, but top-of-hour scans start alongside that refresh. The offset is not a completion guarantee; the daily option does not serialize those jobs.

The time must be 24-hour `HH:mm` and the timezone must be an IANA name. Both values are required together; invalid or partial configuration stops startup scheduling with an explicit error. With both unset (or empty), the existing interval and half-hour offset remain unchanged.

The existing `node-schedule` calendar rule follows the selected timezone through daylight saving changes: 03:00 in Chicago is 08:00 UTC in summer and 09:00 UTC in winter. Times skipped by a spring clock change have no invocation that day; repeated fall times follow `node-schedule` behavior. Choose a time such as 03:00 outside that transition window. Missed scans while Tunarr is stopped are not replayed.

## Why this fork exists

This fork builds on [upstream Tunarr](https://github.com/chrisbenincasa/tunarr) to make broadcast-style channels more flexible and video processing more efficient, especially on small, low-power computers.

We aim to stay close to upstream, keep our changes focused, and contribute improvements back when they fit. **Our long-term goal is to make this fork unnecessary:** adopt upstream implementations and retire our equivalent patches as they become available. Specialized picture styles can remain optional fork features.

**Measured HDR gains:** on an Intel Core i3-1220P, the optional hardware path delivered **61% higher HDR-to-SDR throughput** with five streams and used **73% less FFmpeg CPU time** in a separate three-stream playback test. See the [hardware comparison](docs/fork/hardware-comparison.md) for the setup, darker HDR picture, and SDR tradeoffs. These are opt-in results, not a claim that every workload runs faster.

### What the combined build adds

| Addition                                   | What it does                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More efficient hardware video processing   | Reduces avoidable conversions in supported video paths. Bundles our matching FFmpeg build, direct NV12 shader output, optional driver-default scaling, and optional VAAPI HDR conversion. Hardware-specific options are opt-in; improvements measured on our Intel system are not promises for every GPU.                               |
| CRT, TV Broadcast, and DVD Broadcast looks | Gives modern screens a softer broadcast or CRT-inspired picture, with optional scanlines, glow, color bleed, and grain. Choose a look per channel or leave the picture unfiltered. TV and DVD Broadcast use different degrees of softness; they do not recreate a physical analog signal. Currently configured through the channel API. |
| After-show ad pods                         | Places an ordered break after a complete program: for example, a bumper, two commercials, and a station ID drawn from your selected filler pools. Available through the random-slot scheduling API; there is no pod editor in the UI yet.                                                                                               |
| Final-credit controls                      | Lets a channel advance when a valid final-credits marker begins. Programs without a valid marker play in full, and source files stay unchanged.                                                                                                                                                                                         |
| Playback and subtitle fixes                | Includes targeted native fixes for audio timing at program boundaries and subtitle delivery. See [the container notes](docs/fork/container.md) for source revisions and validation limits.                                                                                                                                              |

[See the CRT, TV Broadcast, and DVD Broadcast picture comparisons](https://imgur.com/a/FvFRizg). These are appearance previews; image hosting and display scaling can change fine texture.

**One image, one installation path.** The combined release contains Tunarr and its matching FFmpeg; you do not need to choose or combine development branches. Hardware options and exact source links are in [the container notes](docs/fork/container.md).

## What is Tunarr?

Tunarr lets you build custom live TV channels out of your existing media libraries — movies, TV episodes, music videos, or local files — and stream them as if they were real broadcast channels.

Tune in by adding Tunarr's spoofed HDHomeRun tuner to Plex, Jellyfin, or Emby, or grab the M3U URL for any IPTV player like [Tivimate](https://tivimate.com/) or [UHF](https://www.uhfapp.com/).

## Features

**Media Sources**

- Connect Plex, Jellyfin, Emby, or local file libraries
- Advanced search, filter, and sort across all connected libraries

**Channel Management**

- Drag-and-drop lineup editor
- Filler content between programs (commercials, music videos, prerolls, branding)
- Per-channel logos and automatic configuration backups

**Scheduling**

- Time-slot and random-slot scheduling tools
- Web-based TV guide for viewing channel lineups

**Playback & Integration**

- Spoofed [HDHR](https://www.silicondust.com/hdhomerun/) tuner for Plex, Jellyfin, and Emby
- M3U/IPTV output for [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr), [Threadfin](https://github.com/Threadfin/Threadfin), [xTeVe](https://github.com/xteve-project/xTeVe), or any IPTV client
- Stream channels directly in the browser
- Per-channel audio language and subtitle preferences

**Transcoding**

- Hardware-accelerated transcoding: Nvidia NVENC, VAAPI, Intel QuickSync, macOS VideoToolbox
- Multiple transcode profiles, configurable per channel

## Screenshots

<table>
  <tr>
    <td align="center"><img src="./design/tunarr-channels.png" alt="Channel Management"><br><em>Channel Management</em></td>
    <td align="center"><img src="./docs/assets/channel-properties.png" alt="Channel Configuration"><br><em>Channel Configuration</em></td>
  </tr>
</table>

## Quick Start

The [public container](https://github.com/TacoRocket/tunarr/pkgs/container/tunarr) bundles Tunarr and its matching FFmpeg. No registry login or branch selection is needed. Every published version is on the [Releases page](https://github.com/TacoRocket/tunarr/releases), with notes on what changed and anything to do before upgrading. The example below uses `2026.10.4-trfork.10`; the [latest release](https://github.com/TacoRocket/tunarr/releases/latest) may be newer.

The current container recipe runs Tunarr on **Bun**. Older published images keep
their original runtime; see [container runtime and releases](docs/fork/container.md#runtime)
for the Bun version pin and publication steps.

The fork image is initially **Linux x86-64 (`linux/amd64`)**. Create a `compose.yaml`:

```yaml
services:
  tunarr:
    image: ghcr.io/tacorocket/tunarr:2026.10.4-trfork.10
    container_name: tunarr
    ports:
      - 8000:8000
    environment:
      - TZ=Etc/UTC
    volumes:
      - ./tunarr-data:/config/tunarr
    restart: unless-stopped
```

Then run:

```bash
docker compose up -d
```

Tunarr will be available at `http://localhost:8000`.

**Next:** set up your channels as usual, then check out the [fork docs](docs/fork/README.md) to switch on CRT looks, ad pods and more.

Connect your media server in Tunarr, or add a read-only media volume for local files. For Intel/AMD hardware access, GPU-specific options, source revisions, and rollback instructions, see [the container notes](docs/fork/container.md). Start with a separate configuration directory when trying the fork; keep a configuration backup before upgrading an existing install.

**Upstream installation options:** these install upstream Tunarr and do not include this fork's additions.

| Platform                 | Method                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| Linux / macOS / Windows  | [Standalone binaries](https://github.com/chrisbenincasa/tunarr/releases)      |
| Unraid                   | Community App Store                                                           |
| Proxmox                  | [LXC helper script](https://tunarr.com/getting-started/installation/#proxmox) |
| ARM (Raspberry Pi, etc.) | Docker image (`linux/arm64`)                                                  |

For hardware-accelerated transcoding setup, see the [transcoding docs](https://tunarr.com/getting-started/run/).

## Documentation

- [Fork docs](docs/fork/README.md): CRT looks, ad pods, skipping credits, hardware options
- [Installation guide](https://tunarr.com/getting-started/installation/)
- [Creating channels](https://tunarr.com/configure/channels/)
- [Scheduling tools](https://tunarr.com/configure/scheduling/)
- [Transcoding configuration](https://tunarr.com/configure/ffmpeg/transcode_config/)
- [Full documentation](https://tunarr.com/)

## Development

```bash
pnpm i
pnpm turbo dev  # backend at :8000, frontend at :5173/web
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for a full development guide.

Fork CI validates ready code PRs to `main`; container publication is manual. We use upstream's documentation site and native platform releases, while testing our combined source and publishing our own Linux x86-64 image. See [the CI and release process](docs/fork/container.md#ci-and-release-checks).

## Community

This fork exists because of [upstream Tunarr](https://github.com/chrisbenincasa/tunarr) and the people who build it. Please keep fork reports here so they don't add to upstream's queue.

- **Problems with this build** (any version ending in `-trfork.N`): [open a fork issue](https://github.com/TacoRocket/tunarr/issues). If you can reproduce the same problem on an upstream Tunarr build, it's upstream's bug; report it there, and mention it here.
- **Feedback on fork features** (CRT looks, ad pods, final-credit controls, low-power encoding): fork issues, the [first-release feedback thread](https://github.com/TacoRocket/tunarr/pull/25), or [pull requests](https://github.com/TacoRocket/tunarr/pulls).
- **General Tunarr questions**: upstream's [documentation](https://tunarr.com/), [Discord](https://discord.gg/7tUjBbDxag) and [Discussions](https://github.com/chrisbenincasa/tunarr/discussions). Mention that you run this fork.

## License

Tunarr is released under the [Zlib License](LICENSE).

Tunarr and the underlying media libraries remain the work of their respective authors. Our FFmpeg build builds on [ErsatzTV-ffmpeg](https://github.com/ErsatzTV/ErsatzTV-ffmpeg), FFmpeg, libplacebo, and their contributors; their licenses and attribution continue to apply.
