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
biggest savings also need the [custom runtime options](container.md). Without
them it still works and looks the same; it just saves less GPU work. See
[If it doesn't look right](#if-it-doesnt-look-right).
The output follows the resolution set in the channel's transcode profile. A
supported native runtime can use optimized output at other sizes too; it is no
longer limited to a 1080p profile. Picture fitting and black bars stay unchanged.
Experimental color sampling and eligible DVD Broadcast HDR10 also follow the
channel resolution. The same runtime capabilities and opt-ins are required.
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
output when the active picture has positive, even dimensions and the runtime
supports it, including 4:3 and widescreen pictures with black bars. Experimental
uses point-sampled color on that path too; fine color detail can alias compared
with filtered color. Padding stays outside the shader. The worker checks its own
FFmpeg capability and retains the filtered conversion when it is unavailable.
It needs a
VAAPI profile and a fork worker containing the active-picture sampling extension.
Older worker overrides keep filtered color for pictures with black bars.

HDR programs play without the look, except DVD Broadcast on Performance or
Experimental with the fixed-Hable option and the direct NV12 runtime. Those
keep the look on eligible HDR10 at the channel resolution, including pictures
that need black bars.

The Experimental shader's color bleed is sized for the full frame. For a
narrower picture, such as 4:3, its weights differ from Tunarr's own pipeline
by rounding only.

## If it doesn't look right

Most surprises come from one of the cases below. Each one says what you'll see and what to do.

A channel plays through one of two backends, and a few answers differ between them:

- **Tunarr's own pipeline**, the default.
- **[ErsatzTV next](../configure/ffmpeg/ersatztv-next.md)**, when **ErsatzTV next (Experimental)** is selected under **Playback engine** (Streaming tab), or when it's turned on for all channels.

To check a channel (`true` means ErsatzTV next):

```bash
curl -s $TUNARR/api/channels/$CHANNEL | jq .useEtvNext
```

### I turned on a look, but the channel looks normal

Work down this list:

1. **Restart the stream.** A new look shows up the next time the channel starts. Change channels and come back.
2. **Make sure CRT is on for that channel.** You should see `"enabled": true` and your look:

   ```bash
   curl -s $TUNARR/api/channels/$CHANNEL | jq .crt
   ```

3. **Make sure the channel's transcode profile uses VAAPI.** An Intel GPU can be set to either QSV or VAAPI, and both play video fine. CRT looks only run with **VAAPI**. With QSV, NVIDIA or no hardware acceleration, the channel plays normally without the look.
   - **Tunarr's own pipeline** doesn't warn you.
   - **ErsatzTV next** writes this to the log: `Some settings do not map onto the ErsatzTV next backend: crt: the backend draws the CRT look only with VAAPI`.
4. **Make sure the channel's stream mode lets the video be redrawn.**
   - **Tunarr's own pipeline:** HLS Direct and HLS Direct v2 pass the original video through untouched, so there's nothing to draw the look on. Use **HLS**, **HLS alt** or **MPEG-TS**.
   - **ErsatzTV next:** HLS, HLS Direct v2 and MPEG-TS all go to the worker. With a look on, it redraws the video and the look, even on HLS Direct v2, which otherwise passes the video through. HLS alt and HLS Direct always stay on Tunarr's own pipeline, so on HLS Direct there's still no look.

### One movie plays without the look, then the look comes back

That movie is HDR. To keep its colors right, the look is skipped for HDR programs unless everything below is in place; it comes back with the next regular program. Black bars don't matter: a wide movie that needs bars added keeps the look too.

On both backends, an HDR10 movie keeps the look only when:

- the look is `dvd-broadcast`;
- the tier is Performance or Experimental;
- the [direct NV12 and fixed-Hable options](container.md) are set.

Each backend adds its own conditions:

- **Tunarr's own pipeline** also needs HDR tone mapping turned on (`TUNARR_TONEMAP_ENABLED`; see [the transcode config notes](../configure/ffmpeg/transcode_config.md#hdr-tonemapping)) and a transcode profile that encodes H.264. It skips movies it identifies as Dolby Vision, even when there's an HDR10 picture underneath ([#157](https://github.com/TacoRocket/tunarr/issues/157)).
- **ErsatzTV next** has no H.264 requirement. It treats only Dolby Vision profile 5 as Dolby Vision, so an HDR10 movie that also carries Dolby Vision information keeps the look there.

### Experimental's color looks a little different from Performance

That's expected. Experimental samples color more sharply, which makes the fine colored stripes of the CRT mask a little crisper; brightness and detail stay the same. It needs the [direct NV12 options](container.md).

- **Tunarr's own pipeline** does this for every picture shape, 4:3 shows and movies with bars included.
- **ErsatzTV next** does it only when the picture fills the whole screen. A 4:3 show gets the regular color sampling there, so it can look very slightly different on the two backends.

### Performance or Experimental doesn't lower my GPU use much

Both tiers work without extra setup, but the biggest savings need the [direct NV12 options](container.md). Without them, the picture is drawn the standard way with more GPU work. The one visible difference is Experimental's sharper color (above).

- **Tunarr's own pipeline** logs `Direct NV12 is unavailable for this CRT runtime or geometry`.
- **ErsatzTV next:** the worker checks its own FFmpeg and uses the standard way when it has to.

Both tiers also ask your GPU for low-power encoding. If it can't do that, the regular encoder is used: same picture, a little more GPU load.

### Seeing what Tunarr changed

While a channel is playing, Tunarr lists anything it had to do differently from your settings, each with a plain message:

```bash
curl -s $TUNARR/api/sessions | jq 'map_values(map(.degradations))'
```

- **Tunarr's own pipeline:** this covers HDR movies that skipped the look and low-power encoding that wasn't available. It doesn't cover the wrong profile or stream mode, so check those yourself.
- **ErsatzTV next:** this covers subtitle problems and the worker's own fallbacks:
  - decoding, encoding or tone mapping done on the CPU instead of the GPU;
  - low-power encoding that wasn't available;
  - HDR movies that skipped the look;
  - a look the worker couldn't draw on this machine.

  A profile that isn't VAAPI shows only in the log line above.

## Good to know

- **GPU only.** CRT looks need a VAAPI transcode profile (Intel or AMD). On Intel, pick VAAPI, not QSV. They don't run on CPU-only or other GPU setups yet.
- **HDR movies can keep the look.** On DVD Broadcast with Performance or Experimental, HDR10 movies stay in the CRT look, using a fixed HDR conversion that can look a little darker than the default. Quality, other looks and other HDR types skip the effect for HDR; the look returns for regular programs. See [One movie plays without the look](#one-movie-plays-without-the-look-then-the-look-comes-back) for the full conditions.
- **Burned-in captions get softer.** The broadcast looks lower the detail, and that includes captions that are part of the video. Subtitles Tunarr adds itself stay sharp.
- **Tested on Intel.** We run it on a 12th-gen Intel box. Other GPUs may work, but we haven't tested them. If something breaks, [let us know](https://github.com/TacoRocket/tunarr/issues).

<details>
<summary>Under the hood</summary>

The effect is a CRT-Lottes shader running through libplacebo on the GPU. The broadcast looks first shrink the picture to 480 or 360 lines, then scale it back up. The full technical notes, measurements and limits are in the [CRT developer notes](../../server/src/ffmpeg/builder/filter/crt/README.md).

</details>
