# Credit squeeze

Credit squeeze keeps the end credits playing in a smaller box over your channel's background. The credits audio continues, and the next program starts at its original time. It is off by default.

This first version snaps to the smaller picture at the final-credit marker. It does not animate the transition, play a second video, or start an ad early. It uses the same final-credit markers as [Skip the end credits](scheduling.md#skip-the-end-credits), but keeps the credits instead of skipping them. With no single valid final-credit marker, playback stays full-screen.

## What you need

- A transcoded channel using VAAPI encoding, with hardware filters enabled (`hls`, `hls_slower`, or `mpegts`).
- FFmpeg with `libplacebo`, `scale_vulkan`, `overlay_vaapi`, and the fork's `concat=preserve_ts=1` patch, plus working VAAPI/Vulkan sharing. Older fork containers and ordinary FFmpeg builds do not include the join patch. Check `ffmpeg -hide_banner -help filter=concat` for `preserve_ts` before enabling this feature. The hardware trial used Intel; other drivers are not yet validated.
- A PNG or JPEG on a path Tunarr can read **inside its container**. Mount your artwork folder read-only, for example `./artwork:/artwork:ro`. Remote image URLs are not supported.
- Final-credit skipping disabled on this channel. The API rejects enabling both settings together.

The output uses Tunarr's existing 8-bit transcode path. CRT is optional; when enabled, it is applied to the combined picture, including the background. Burned-in subtitles and the watermark shrink with the program. Subtitle sidecars remain under the player's control.

## Prepare a background

Use a 16:9 image, ideally 1280×720 or 1920×1080. The background fills the output canvas. At 1280×720, the credits cover **x=48, y=162, width=704, height=396**. Those proportions scale with the channel's output size.

Keep that rectangle plain and dark. Put your branding and message on the right or in the outer margins. For a CRT look or composite TV, use large, bold lettering and keep it away from the edges. The background is loaded once per transcode, then reused on the GPU.

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
      "backgroundImage": "/artwork/colony-drop.png"
    }' channel-before-squeeze.json > channel-with-squeeze.json

curl --fail --silent --show-error -X PUT \
  -H 'Content-Type: application/json' \
  --data-binary @channel-with-squeeze.json \
  "$TUNARR_URL/api/channels/$CHANNEL_ID"
```

**If this channel was skipping credits**, setting `advanceAtFinalCredits` to `false` restores the saved full program durations through the existing scheduling reconciliation. That can move later programs compared with the shortened lineup. Credit squeeze itself never changes durations, audio, or the stream's requested end time.

Changes take effect on the next transcode, not partway through an already-running process. Offset channels inherit this setting from their source; change it on the source channel.

To turn it off, fetch the current channel, set `.creditSqueeze = null`, and PUT that updated document. Omitting `creditSqueeze` on an update preserves the saved setting. Turning it off does not turn credit skipping back on.

## Cost and troubleshooting

Before the final-credit marker, frames follow the full-screen path. Only the credit frames pass through the compositor. A timestamp-preserving join keeps both parts on the source clock, including gaps in the source. Joining during the credits goes straight to the smaller picture.

The extra filters still reserve some memory when the transcode starts. CPU and GPU composition work begins at the marker, and uses more resources while the credits play. Programs without a usable marker do not add the image input or compositor. This is a presentation feature, not a performance optimization.

The source video controls output timestamps and end-of-file. The still image cannot keep playback running after the program ends. Audio goes through the same path as ordinary playback.

A missing or unreadable image, an unsupported profile, an FFmpeg build without the join patch, or a GPU initialization failure is reported as a playback error. Disable credit squeeze or correct the path/profile/runtime before retrying. Missing or ambiguous chapter metadata simply leaves the picture full-screen. This version does not guess credit boundaries.

The PR records matched native-command timing, audio-packet and end-of-file checks. Those isolated renders do not establish long-running TV-client acceptance; that remains a separate check after review and an approved deployment.
