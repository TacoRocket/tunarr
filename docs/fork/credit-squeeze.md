# Credit squeeze

Credit squeeze keeps the end credits playing in a smaller box over your channel's background. The credits audio continues, and the next program starts at its original time. It is off by default.

The native backend snaps to the smaller picture at the final-credit marker. The next backend also supports the fork worker enhancements described below. It uses the same final-credit markers as [Skip the end credits](scheduling.md#skip-the-end-credits), but keeps the credits instead of skipping them. With no single valid final-credit marker, playback stays full-screen.

## What you need

- A transcoded channel using VAAPI encoding, with hardware filters enabled (`hls`, `hls_slower`, or `mpegts`).
- FFmpeg with `libplacebo`, `scale_vulkan`, `overlay_vaapi`, and the fork's `concat=preserve_ts=1` patch, plus working VAAPI/Vulkan sharing. Older fork containers and ordinary FFmpeg builds do not include the join patch. Check `ffmpeg -hide_banner -help filter=concat` for `preserve_ts` before enabling this feature. The hardware trial used Intel; other drivers are not yet validated.
- A PNG or JPEG on a path Tunarr can read **inside its container**. Mount your artwork folder read-only, for example `./artwork:/artwork:ro`. Remote image URLs are not supported.
- Final-credit skipping disabled on this channel. The API rejects enabling both settings together.

The output uses Tunarr's existing 8-bit transcode path. HDR items stay full-screen until squeeze has been validated for HDR; their ordinary HDR handling is retained. CRT is optional; when enabled, it is applied to the combined picture, including the background. Burned-in subtitles shrink with the program. The channel logo stays at its normal full-frame size and position, over the completed picture. Subtitle sidecars remain under the player's control.

## On the ErsatzTV next backend

Requires fork worker `v0.2.4-trfork.12` or later; Tunarr bundles the pinned worker.

The same channel setting also applies on ErsatzTV next. Tunarr selects the final
credit marker and sends it with the program; the worker draws the squeeze. The
program keeps its original end time and audio. Joining during the credits starts
with the picture already squeezed. Missing or ambiguous markers leave the picture
full-screen.

The worker needs the same VAAPI/Vulkan and timestamp-preserving concat support.
HDR programs stay full-screen. Burned-in subtitles shrink with the picture, CRT
is applied to the combined picture, and the channel watermark stays full-sized.
When the worker cannot prepare the squeeze, the sessions API reports
`credit_squeeze_unavailable` and the program plays full-screen. This does not add
an automatic retry for a GPU or image-decoding failure after FFmpeg starts.

## Moving advertisements on next

This addition needs the moving-ad fork worker, which is not yet in the bundled
`v0.2.4-trfork.12` release. Do not enable it with that older worker. The consumer
PR stays draft until a reviewed worker release is pinned and its packaged handoff
is checked. The global next feature flag and this channel's `useEtvNext` must be on.

Add `advertisementFillerListIds` to `creditSqueeze` in the existing channel API:

```json
{
  "useEtvNext": true,
  "advanceAtFinalCredits": false,
  "creditSqueeze": {
    "enabled": true,
    "backgroundImage": "/artwork/credits.png",
    "advertisementFillerListIds": ["<filler-list UUID>"]
  }
}
```

Merge these fields into the fetched channel document before PUT, as in the
example below. The image field remains required for compatibility; moving-ad mode
uses the selected video instead. Removing `advertisementFillerListIds` restores
still mode.

At the final-credit marker, the program moves over one second into a small
lower-left inset, 25% of the channel width with 3% left/bottom margins. Its aspect
ratio is preserved. The ad occupies the background canvas, and its audio replaces
the credits audio; an ad without audio plays silently. The existing channel logo
remains full-sized. Ads are selected from the supplied filler lists, using the
same shuffle-bag selection as after-show pods. They advance at whole-clip
boundaries until the scheduled program end, when the current ad is cut and the
ordinary lineup resumes. The existing after-show pod is not consumed or moved.

Selections are shared across sessions for the airing. Joining partway through
seeks into that same ad and resumes any entrance already in progress. A bounded
in-memory cache retains the plan through the airing; restart reconstructs the
same selection when the catalog and pools are unchanged. Pool edits take effect
on later uncached airings. The selector requires clips at least one second long,
limits plans to 2,000 clips and retains at most 512 concurrent airing plans.

An unavailable pool or unresolved ad retains the full-screen program and its
audio with `credit_squeeze_unavailable`. Worker capability/probe failures also
keep picture and audio together. A failure after FFmpeg starts uses its existing
failure handling, rather than promising seamless recovery. The short checks cover
command rendering and scheduling handoff separately; packaged worker sessions and
sustained playback remain unverified.

## Prepare a background

Use a 16:9 image, ideally 1280×720 or 1920×1080. The background fills the output canvas. At 1280×720, the credits cover **x=64, y=162, width=704, height=396**. The left edge sits on the 5% TV-safe inset. Those proportions scale with the channel's output size.

Keep that rectangle plain and dark. Put your branding and message on the right or in the outer margins. For a CRT look or composite TV, use large, bold lettering and keep it away from the edges. If the channel already uses a logo, leave its configured corner clear so it does not cover the message. The background is loaded once per transcode, then reused on the GPU.

## Enable it through the API

There is no settings-page control yet. This example requires `curl` and `jq`. Replace the server URL, channel ID and artwork path. Keep the fetched JSON as your settings checkpoint.

```bash
TUNARR_URL=http://localhost:8000
CHANNEL_ID=your-channel-id

curl --fail --silent --show-error \
  "$TUNARR_URL/api/channels/$CHANNEL_ID" > channel-before-squeeze.json

jq '.advanceAtFinalCredits = false |
    .creditSqueeze = {
      "enabled": true,
      "backgroundImage": "/artwork/channel-background.png"
    }' channel-before-squeeze.json > channel-with-squeeze.json

curl --fail --silent --show-error -X PUT \
  -H 'Content-Type: application/json' \
  --data-binary @channel-with-squeeze.json \
  "$TUNARR_URL/api/channels/$CHANNEL_ID"
```

**If this channel was skipping credits**, setting `advanceAtFinalCredits` to `false` restores the saved full program durations through the existing scheduling reconciliation. That can move later programs compared with the shortened lineup. Still-image credit squeeze never changes durations, audio, or the stream's requested end time.

Changes take effect on the next transcode, not partway through an already-running process. Offset channels inherit this setting from their source; change it on the source channel.

To turn it off, fetch the current channel, set `.creditSqueeze = null`, and PUT that updated document. Omitting `creditSqueeze` on an update preserves the saved setting. Turning it off does not turn credit skipping back on.

## Cost and troubleshooting

Before the final-credit marker, frames follow the full-screen path. Only the credit frames pass through the compositor. A timestamp-preserving join keeps both parts on the source clock, including gaps in the source. Joining during the credits goes straight to the smaller picture.

The extra filters still reserve some memory when the transcode starts. CPU and GPU composition work begins at the marker, and uses more resources while the credits play. Programs without a usable marker do not add the image input or compositor. The logo keeps the existing software overlay, with a GPU download/upload around it. When bitmap subtitles also need a software overlay, their placement inside the credits can require a separate transfer pair. This is a presentation feature, not a performance optimization.

The source video controls output timestamps and end-of-file. The still image cannot keep playback running after the program ends. Audio goes through the same path as ordinary playback.

When setup detects an unreadable background, an incompatible profile, missing FFmpeg support, or an HDR item, playback stays full-screen and stream status reports `credit_squeeze_unavailable`. The API rejects enabling squeeze with an incompatible profile or a runtime without the join patch. A failure after FFmpeg starts, such as GPU initialization or image decoding, can still cause a playback error; this version does not restart a failed process without squeeze. Missing or ambiguous chapter metadata simply leaves the picture full-screen. This version does not guess credit boundaries.

The PR records matched full-build timing, audio-packet and natural-end checks, plus playback through an isolated Tunarr server's HTTP/HLS endpoint into the next program. These checks do not establish long-running TV-client acceptance; that remains a separate check after review and an approved deployment.
