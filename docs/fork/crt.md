# CRT looks

**CRT looks** make a channel look like it's playing on an old tube TV: scanlines, a soft glow, a little color bleed. You pick a look per channel, so your Saturday-morning cartoons channel can go full retro while your movie channel stays crisp.

## The looks

| Look | What it feels like |
| --- | --- |
| `subtle` | A light CRT texture. Flat screen, keeps the picture sharp. |
| `classic-flat` | Clear scanlines, a bit of color bleed and glow. The classic look. |
| `strong` | Curved screen and heavy texture. Loud on purpose. |
| `dvd-broadcast` | A softer, standard-definition picture (480 lines) with flat scanlines. Like a DVD on a 2000s TV. |
| `tv-broadcast` | Softer still (360 lines). Like catching it live on cable. |

The two broadcast looks are about the *feel*. They aren't a real analog signal.

[See them side by side](https://imgur.com/a/FvFRizg).

## Turning it on

You need a GPU transcode profile first (Intel or AMD with VAAPI). See [the container notes](container.md) if you haven't set that up.

1. Find your channel's ID:

   ```bash
   TUNARR=http://localhost:8000
   curl -s $TUNARR/api/channels | jq -r '.[] | "\(.number)  \(.name)  \(.id)"'
   ```

2. Pick a look and switch it on (this one is `classic-flat`):

   ```bash
   CHANNEL=paste-the-id-here
   curl -s $TUNARR/api/channels/$CHANNEL \
     | jq '.crt = {"enabled": true, "look": "classic-flat"}' \
     | curl -s -X PUT $TUNARR/api/channels/$CHANNEL \
         -H 'Content-Type: application/json' -d @-
   ```

3. Tune in to the channel. The look shows up the next time the channel starts streaming. If it's already playing, change channels and come back.

To turn it off, run step 2 with `.crt = null`.

The commands use `curl` and `jq`. Most Linux and Mac setups have them, or they're one install away.

## Extras for the broadcast looks

These only apply to `dvd-broadcast` and `tv-broadcast`. Add them inside the `crt` part of step 2:

| Extra | What it adds |
| --- | --- |
| `"broadcastGrain": true` | A light, moving film grain. Use `"half"` for an even lighter touch. |
| `"broadcastTexture": "classic-flat"` | A stronger scanline mask, like `classic-flat`. |
| `"broadcastComposite": true` | A composite-video signal feel. |

For example, the full late-night combo:

```bash
jq '.crt = {"enabled": true, "look": "dvd-broadcast", "broadcastGrain": "half", "broadcastTexture": "classic-flat", "broadcastComposite": true}'
```

Setting `crt` replaces the whole thing, so include every extra you want to keep.

## Experimental grain optimization

Experimental processing combines composite decoding and grain into one GPU pass.
It saves a little GPU work, with small picture differences possible. Add
`"processing": "experimental"` to the `crt` object above to try it. You also need
a Broadcast look with both composite and grain enabled.

If you dislike the result, change processing back to `"performance"` to restore
the separate passes. Omitted processing and `"standard"` also keep them separate.
Keep the rest of your `crt` options when updating the channel.

This opt-in does not turn on hardware offload settings or change defaults. The
broader Quality/Performance preset selector is still planned in
[issue #72](https://github.com/TacoRocket/tunarr/issues/72); the existing API value
`"performance"` retains its earlier meaning.

## Good to know

- **GPU only.** CRT looks need a VAAPI transcode profile (Intel or AMD). They don't run on CPU-only or other GPU setups yet.
- **HDR movies play without the look.** HDR content skips the effect and plays normally. The look comes back for the next regular program.
- **Burned-in captions get softer.** The broadcast looks lower the detail, and that includes captions that are part of the video. Subtitles Tunarr adds itself stay sharp.
- **Tested on Intel.** We run it on a 12th-gen Intel box. Other GPUs may work, but we haven't tested them. If something breaks, [let us know](https://github.com/TacoRocket/tunarr/issues).

<details>
<summary>Under the hood</summary>

The effect is a CRT-Lottes shader running through libplacebo on the GPU. The broadcast looks first shrink the picture to 480 or 360 lines, then scale it back up. The full technical notes, measurements and limits are in the [CRT developer notes](../../server/src/ffmpeg/builder/filter/crt/README.md).

</details>
