<p align="center">
  <img src="./design/tunarr-guide.png" alt="Tunarr TV Guide">
</p>

<h1 align="center">Tunarr — TacoRocket's fork</h1>

<p align="center">Create your own live TV channels from media on Plex, Jellyfin, Emby, or local files.</p>

<p align="center">
  <a href="https://github.com/chrisbenincasa/tunarr/releases"><img src="https://img.shields.io/github/v/release/chrisbenincasa/tunarr?style=flat&logo=github&color=lightseagreen" alt="GitHub Release"></a>
  <a href="https://hub.docker.com/r/chrisbenincasa/tunarr"><img src="https://img.shields.io/docker/pulls/chrisbenincasa/tunarr?style=flat&logo=docker&color=lightseagreen" alt="Docker Pulls"></a>
  <a href="https://github.com/chrisbenincasa/tunarr/stargazers"><img src="https://img.shields.io/github/stars/chrisbenincasa/tunarr?style=flat&logo=github&color=lightseagreen" alt="GitHub Stars"></a>
  <a href="https://discord.gg/7tUjBbDxag"><img src="https://img.shields.io/discord/1254564006123802805?style=flat&logo=discord&logoColor=white&label=Discord" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Zlib-lightseagreen?style=flat" alt="License"></a>
</p>

---

## Why this fork exists

This fork builds on [upstream Tunarr](https://github.com/chrisbenincasa/tunarr) to make broadcast-style channels more flexible and video processing more efficient, especially on small, low-power computers.

We aim to stay close to upstream, keep our changes focused, and contribute improvements back when they fit. **Our long-term goal is to make this fork unnecessary:** adopt upstream implementations and retire our equivalent patches as they become available. Specialized picture styles can remain optional fork features.

### What the combined build adds

| Addition                                   | What it does                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More efficient hardware video processing   | Reduces avoidable conversions in supported video paths. Bundles our matching FFmpeg build, direct NV12 shader output, optional driver-default scaling, and optional VAAPI HDR conversion. Hardware-specific options are opt-in; improvements measured on our Intel system are not promises for every GPU.                               |
| CRT, TV Broadcast, and DVD Broadcast looks | Gives modern screens a softer broadcast or CRT-inspired picture, with optional scanlines, glow, color bleed, and grain. Choose a look per channel or leave the picture unfiltered. TV and DVD Broadcast use different degrees of softness; they do not recreate a physical analog signal. Currently configured through the channel API. |
| After-show ad pods                         | Places an ordered break after a complete program: for example, a bumper, two commercials, and a station ID drawn from your selected filler pools. Available through the random-slot scheduling API; there is no pod editor in the UI yet.                                                                                               |
| Final-credit controls                      | Lets a channel advance when a valid final-credits marker begins. Programs without a valid marker play in full, and source files stay unchanged.                                                                                                                                                                                         |
| Playback and subtitle fixes                | Includes targeted native fixes for audio timing at program boundaries and subtitle delivery. See [the container notes](docs/fork-container.md) for source revisions and validation limits.                                                                                                                                              |

[See the CRT, TV Broadcast, and DVD Broadcast picture comparisons](https://imgur.com/a/FvFRizg). These are appearance previews; image hosting and display scaling can change fine texture.

**One image, one installation path.** The combined release contains Tunarr and its matching FFmpeg; you do not need to choose or combine development branches. Hardware options and exact source links are in [the container notes](docs/fork-container.md).

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

The first public image is being built. The example below targets that release; it is not available until the [publication workflow](https://github.com/TacoRocket/tunarr/actions/workflows/build-and-push-docker.yml) succeeds and the package is public.

The fork image is initially **Linux x86-64 (`linux/amd64`)**. Create a `compose.yaml`:

```yaml
services:
  tunarr:
    image: ghcr.io/tacorocket/tunarr:2026.10.4-fork.1
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

Connect your media server in Tunarr, or add a read-only media volume for local files. For Intel/AMD hardware access, GPU-specific options, source revisions, and rollback instructions, see [the container notes](docs/fork-container.md). Start with a separate configuration directory when trying the fork; keep a configuration backup before upgrading an existing install.

**Upstream installation options:** these install upstream Tunarr and do not include this fork's additions.

| Platform                 | Method                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| Linux / macOS / Windows  | [Standalone binaries](https://github.com/chrisbenincasa/tunarr/releases)      |
| Unraid                   | Community App Store                                                           |
| Proxmox                  | [LXC helper script](https://tunarr.com/getting-started/installation/#proxmox) |
| ARM (Raspberry Pi, etc.) | Docker image (`linux/arm64`)                                                  |

For hardware-accelerated transcoding setup, see the [transcoding docs](https://tunarr.com/getting-started/run/).

## Documentation

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

## Community

- [Fork issues and feedback](https://github.com/TacoRocket/tunarr/issues) — report problems with this image here first. Contributions are welcome through pull requests.
- [Discord](https://discord.gg/7tUjBbDxag) — chat, help, and announcements
- [GitHub Issues](https://github.com/chrisbenincasa/tunarr/issues) — bug reports and feature requests
- [GitHub Discussions](https://github.com/chrisbenincasa/tunarr/discussions) — questions and general conversation

## License

Tunarr is released under the [Zlib License](LICENSE).

Tunarr and the underlying media libraries remain the work of their respective authors. Our FFmpeg build builds on [ErsatzTV-ffmpeg](https://github.com/ErsatzTV/ErsatzTV-ffmpeg), FFmpeg, libplacebo, and their contributors; their licenses and attribution continue to apply.
