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

## Processing tiers

The look picks the style. `processing` chooses how Tunarr uses your GPU to draw it.

| Setting | What you get |
| --- | --- |
| `"quality"` (default) | The reference picture, using the baseline processing path. |
| `"performance"` | Keeps filtered color and asks the GPU's video engines to handle more of the work. Tested on Intel; the amount saved depends on your hardware and content. |
| `"experimental"` | Uses additional shortcuts to reduce GPU work. Fine color detail and grain can look slightly different. |

Add `"processing": "performance"` or `"experimental"` inside `crt` in step 2.
To return to Quality, set `"processing": "quality"` or remove that field.
Keep the look and every extra you want to retain. The next stream uses the new
choice; changing the setting does not restart an already-playing stream.

Quality still uses your configured hardware decoder and encoder. Performance
requests dedicated scaling and low-power H.264 encoding where supported. Its
optimized output also needs the [custom runtime options](container.md). If that
output path is unavailable, Tunarr logs the reason and uses the supported path.
An explicit low-power choice in your encoding profile still applies in Quality.

Only Experimental makes the extra tradeoffs in fine color detail and grain. It
combines grain with composite when both are enabled; grain without composite
still runs separately.
Experimental describes a picture tradeoff, not how new or well-tested a feature is.
The [developer notes](../../server/src/ffmpeg/builder/filter/crt/README.md)
explain the individual optimizations and hardware requirements.

### Updating an existing installation

Saved `standard`, older `performance`, and missing settings switch to Quality
when you update. The look and extras are kept. Channels already set to
`experimental` stay there. Update any scripts that send `"standard"`; that name
is no longer accepted.

**Review your existing CRT channels before restarting playback.** Quality is the
new default, but it does not preserve every earlier tuning choice:

- Quality restores filtered color and baseline scaling, even if the server's
  `TUNARR_VAAPI_DEFAULT_SCALING` option is enabled. That option still applies to
  channels without CRT.
- Performance restores eligible hardware optimizations while keeping filtered
  color and separate grain processing.
- Experimental is closest to an installation already using optimized output,
  but also combines composite and grain when both are on. It is not an exact
  copy of the old settings.
- Performance and Experimental keep the CRT look on HDR movies too (DVD
  Broadcast, HDR10, with the fixed-Hable option enabled). That HDR conversion
  can look a little darker than the default. Quality skips the look on HDR
  programs and uses the default HDR conversion.

Quality gives you a starting point. Choose a tier for each channel based on the
behavior you want to keep. Keep the existing look, grain,
subtitles and encoding settings when changing the tier. Channels without CRT
need no tier change.

If you roll back, restore the database backup Tunarr made before the update
along with the older image. Reverting only the image will not work with the
updated database.

## On the ErsatzTV next backend

A channel on the experimental [ErsatzTV next backend](../configure/ffmpeg/ersatztv-next.md)
keeps its look, extras and processing tier. Tunarr hands the worker the same
shader its own pipeline draws for the channel's tier, and the worker draws it
on your GPU while it scales the picture. For the broadcast looks it first
scales the picture to 480 or 360 lines. Performance and Experimental use the
driver's dedicated scaler and request low-power encoding there too. With the
[custom runtime options](container.md) set, they also use the direct NV12
output when the picture fills a 1920x1080 frame, as they do here. For a
picture that doesn't fill the frame, such as a 4:3 show, they skip the separate
color conversion step and keep the filtered colour, as a 1440x1080 picture does
here. It needs a
VAAPI profile and the fork's worker build (TacoRocket/next `v0.2.4-trfork.6`
or later), which the fork pins.

HDR programs play without the look, except DVD Broadcast on Performance or
Experimental with the fixed-Hable option and the direct NV12 runtime. Those
keep the look on HDR10, as they do here. On that backend this also covers
HDR10 pictures that don't fill the frame, which Tunarr's own pipeline shows
without the look.

The Experimental shader's color bleed is sized for the full frame. For a
narrower picture, such as 4:3, its weights differ from Tunarr's own pipeline
by rounding only.

## Good to know

- **GPU only.** CRT looks need a VAAPI transcode profile (Intel or AMD). They don't run on CPU-only or other GPU setups yet.
- **HDR movies keep the look on Performance and Experimental.** On DVD Broadcast, HDR10 movies stay in the CRT look, using a fixed HDR conversion that can look a little darker than the default. Quality, other looks and other HDR types skip the effect for HDR; the look returns for regular programs.
- **Burned-in captions get softer.** The broadcast looks lower the detail, and that includes captions that are part of the video. Subtitles Tunarr adds itself stay sharp.
- **Tested on Intel.** We run it on a 12th-gen Intel box. Other GPUs may work, but we haven't tested them. If something breaks, [let us know](https://github.com/TacoRocket/tunarr/issues).

<details>
<summary>Under the hood</summary>

The effect is a CRT-Lottes shader running through libplacebo on the GPU. The broadcast looks first shrink the picture to 480 or 360 lines, then scale it back up. The full technical notes, measurements and limits are in the [CRT developer notes](../../server/src/ffmpeg/builder/filter/crt/README.md).

</details>
