**Hardware options** are fork-only settings that move HDR conversion onto your Intel GPU's video engine, so a small Intel box can run more 4K HDR channels at once.

## Turning them on

Your container needs GPU access and a VAAPI transcode profile first. See [the container notes](https://github.com/TacoRocket/tunarr/blob/main/docs/fork-container.md) for that part. Then:

- In your transcode profile, turn on low-power encoding (`vaapiLowPower`).
- Add `TUNARR_VAAPI_DEFAULT_SCALING=1` to the container's environment.
- Add `TUNARR_VAAPI_HABLE_LUT=1` to the container's environment.
- Restart the container.

To turn them off, remove those lines and restart.

## What you get

On our Intel i3-1220P, five 4K HDR channels at once fell behind on stock Tunarr. With these on, they kept up, and FFmpeg used about a quarter of the CPU.

| Five 4K HDR channels at once | Stock | Fork with options |
| --- | ---: | ---: |
| Speed per channel (1× = keeping up) | 0.65× | 1.05× |

| Three 4K HDR channels at normal speed | Stock | Fork with options |
| --- | ---: | ---: |
| FFmpeg CPU time | 105 s | 28 s |

## Notes

- **HDR only.** SDR channels play fine with these on, but the box tops out at fewer SDR channels at once: about 16% lower in our test. We're looking into why.
- **HDR picture.** These use a fixed tone curve instead of stock's scene-adaptive one, so some scenes can look a little different. We're still comparing the picture against stock.
- **Intel only.** Tested on one 12th-gen Intel PC. Other hardware may not work; if it fails, remove the setting.
- **Options off.** With none of these set, the fork runs about the same as stock.

## Why we did it

Our TV server is a small Intel box, and 4K HDR channels were maxing it out. These options keep it running while we work on getting this kind of improvement into Tunarr itself.

## History

- **2026.10.4-fork.1:** added.

<details>
<summary>Test setup and full numbers</summary>

Measured October 27, 2026, on an Intel Core i3-1220P: stock Tunarr 2026.10.4 against the public `2026.10.4-fork.1` container.

**Maximum throughput.** Five copies of the same clip at once, as fast as possible, averaged over two runs with the order reversed.

| Workload | Stock | Fork defaults | Fork with options |
| --- | ---: | ---: | ---: |
| HDR10 to SDR, speed per stream | 0.653× | 0.656× | 1.052× |
| HDR10 to SDR, total frames/sec | 78.34 | 78.67 | 126.22 |
| SDR, speed per stream | 2.096× | 2.030× | 1.754× |
| SDR, total frames/sec | 314.07 | 304.13 | 262.84 |

**Normal playback speed.** Three HDR streams, 45 seconds (1,080 frames) each.

| Measurement | Stock | Fork with options |
| --- | ---: | ---: |
| Speed per stream | 1.003× | 1.011× |
| FFmpeg CPU time, all three | 104.60 s | 28.11 s |
| GPU general render engine busy | 89.58% | 2.45% |
| GPU video engine busy | 50.47% | 52.61% |
| GPU VideoEnhance engine busy | 0.10% | 48.69% |

Five SDR streams at normal speed kept up on both. Render engine use fell from 38.10% to 1.69%, and FFmpeg CPU time rose from 20.74 s to 26.90 s.

**Setup**

- HDR clip: *I Am Groot* S01E01, 3840×2160 HDR10, 24 fps. SDR clip: *The Eric Andre Show* S02E09, 1440×1080 anamorphic, 29.97 fps. Both started 60 seconds in and were read from the same NAS.
- Output: 1920×1080 H.264 at 8 Mbps, AAC stereo at 192 kbps. Decode, filters, audio, encode and HLS muxing were included; HTTP delivery and player decoding were not.
- Maximum throughput uses the slowest stream's FFmpeg time. GPU numbers come from `intel_gpu_top`, using the middle 60% of each run.
- With options off, the fork's output matched stock exactly in a 48-frame check. With options on, the output differs from stock. CPU time is FFmpeg's user plus system time, added across processes, so it can exceed wall time.
- The two packages differ beyond these options. Stock ships FFmpeg 7.1.1 with Intel iHD 25.4.6; the fork ships FFmpeg 8.1.2 with Intel iHD 26.1.5. Fork defaults match stock closely, so the gain comes from the options.
- No CRT shader or local wrapper was active, so these numbers say nothing about the fork's direct-NV12 shader work.
- These were short runs on one PC. They don't prove long-term reliability or results on other hardware.

Stock:

```text
ghcr.io/chrisbenincasa/tunarr@sha256:6a23935eae275a771f81494e16b591a716baa3bda320c7e7ddbea363cf4900a4
```

Fork:

```text
ghcr.io/tacorocket/tunarr@sha256:6b9fbe9e16230a4eb207e7dcdd646ae24418a2b9b745cec24005dff3fcd0574b
```

Source revisions and the build recipe are in the [release notes](https://github.com/TacoRocket/tunarr/blob/main/docs/fork-container.md#source-and-maintenance).

</details>
