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

The look chooses the effect. `processing` chooses how Tunarr runs it. Omit
`processing`, or set it to `"quality"`, for the default.

| Tier | What it does |
| --- | --- |
| `"quality"` | Base shader with Mitchell-filtered NV12 color. Uses the established renderer and your configured hardware encoder. |
| `"performance"` | Keeps filtered color while requesting dedicated scaling and eligible low-power encoding. Uses optimized direct NV12 when the runtime supports the configured opt-in. |
| `"experimental"` | Adds point color sampling, paired chroma reads and fused composite/grain processing where supported. These save work but can change fine color texture or rounding. |

To try a tier, include `"processing": "performance"` or `"experimental"` inside
`crt` in step 2. Keep the look and every extra you want to retain. To return to
Quality, set `"processing": "quality"` or remove the field from that `crt` object.
The next stream uses the new choice; already-playing streams are not restarted.

Quality and Performance never use point sampling, chroma pairing or grain fusion,
even when server environment options are enabled. Grain fusion requires a
Broadcast look with both composite and grain; grain-only channels retain their
separate pass. Experimental can remain experimental even after extensive testing:
it is an opt-in to a picture tradeoff, not a maturity rating.

Performance requests dedicated VAAPI scaling without needing the global scaling
flag. It tries H.264 VAAPI low-power encoding where eligible, using the existing
capability fallback when unavailable. A profile's explicit low-power choice still
applies in Quality. Direct NV12 needs the [patched runtime options](container.md);
without them, Tunarr logs the fallback and keeps filtered color through the
established handoff. Other GPU backends are not added by these tiers.

### Upgrading older settings

A one-time data migration maps saved `standard`, legacy `performance`, and missing
processing values to `quality`, preserving the look and extras. An explicit
`experimental` value stays Experimental. The API now accepts only `quality`,
`performance` and `experimental`; update scripts that send `standard`.

This is a deliberate behavior change: old Performance meant a different processing
route, and existing point-sampled channels return to filtered Quality until you
choose another tier. After migration, sending `performance` explicitly selects the
new hardware preset. Omitted API/native settings resolve to Quality.

Keep the automatic pre-migration database backup with the previous image for
rollback. Older binaries reject the newer migration history; reverting only the
image is insufficient.

## Good to know

- **GPU only.** CRT looks need a VAAPI transcode profile (Intel or AMD). They don't run on CPU-only or other GPU setups yet.
- **HDR normally plays without the look.** Quality and Performance keep the configured tone mapper and bypass the CRT effect for HDR. Experimental DVD Broadcast can use the existing opt-in fixed-Hable VAAPI LUT for eligible HDR10. Other HDR keeps the bypass; the look returns for regular SDR programs.
- **Burned-in captions get softer.** The broadcast looks lower the detail, and that includes captions that are part of the video. Subtitles Tunarr adds itself stay sharp.
- **Tested on Intel.** We run it on a 12th-gen Intel box. Other GPUs may work, but we haven't tested them. If something breaks, [let us know](https://github.com/TacoRocket/tunarr/issues).

<details>
<summary>Under the hood</summary>

The effect is a CRT-Lottes shader running through libplacebo on the GPU. The broadcast looks first shrink the picture to 480 or 360 lines, then scale it back up. The full technical notes, measurements and limits are in the [CRT developer notes](../../server/src/ffmpeg/builder/filter/crt/README.md).

</details>
