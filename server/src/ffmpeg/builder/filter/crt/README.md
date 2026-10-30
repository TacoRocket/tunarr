# Per-channel CRT processing

This fork adds an opt-in CRT-Lottes shader to native VAAPI transcoding. Channel
settings own the choice; the compatibility wrapper does not implement the effect.
There is no UI in this change.

Use the existing channel create/update API with:

```json
{
  "crt": {
    "enabled": true,
    "look": "subtle",
    "processing": "performance"
  }
}
```

`look` accepts `subtle`, `classic-flat`, `strong`, `dvd-broadcast`, or
`tv-broadcast`. `processing` accepts `standard` (NV12 intermediate),
`performance` (normally an RGBA intermediate), or opt-in `experimental`
(the same processing route as performance, with grain fusion when eligible).
Defaults when enabled are
subtle/performance. Performance can change fine color and mask texture slightly;
standard is the closer match to the original NV12 experiment, not a promise of
unaltered source colors. Both use the same shader preset.

| Look          | Picture reference                                                 |
| ------------- | ----------------------------------------------------------------- |
| Subtle        | Light CRT texture, flat screen, original picture detail           |
| Classic Flat  | More visible scanlines, flat screen, color bleed and edge peaking |
| Strong        | Curved screen and heavier CRT texture                             |
| DVD Broadcast | Softer 480-line picture with flat scanlines and a light mask      |
| TV Broadcast  | Softer still, using a 360-line picture with the same flat texture |

These names describe the intended feel. The broadcast looks do not implement
an analog signal, DVD decoding, interlacing, or a different motion cadence.

Omitting `crt` on an update preserves the saved setting. `null` clears it, and
`enabled: false` disables it while retaining the chosen options. Existing channels
start disabled. Changes take effect when the next stream session loads the channel
settings; already-running FFmpeg processes are not restarted by this setting.

## Optional direct NV12 runtime

The original fork's direct-output trial requires all three process environment values:
`TUNARR_CRT_DIRECT_NV12=1`, `ETV_VAAPI_DIRECT_NV12=1`, and
`ETV_INLINE_NV12_RTZ=1`, with the matching patched FFmpeg/libplacebo build from
TacoRocket/ErsatzTV-ffmpeg. Setting these against an unpatched runtime is not
supported. The runtime's `DIRECT_NV12_OUTPUT=1` build option carries the
libplacebo producer-storage patch; rebuilding Tunarr alone does not supply it.

The revised fork on `perf/nv12-native-layer` instead uses
`TUNARR_CRT_NV12_OUTPUT=native` alongside `TUNARR_CRT_DIRECT_NV12=1` and
`ETV_VAAPI_DIRECT_NV12=1`. This adds `nv12_output=native:range=tv` to the eligible
libplacebo filter. `ETV_INLINE_NV12_RTZ` is unnecessary with that runtime.
The native selector must be paired with a build exposing that filter option;
stock FFmpeg will reject it. An isolated comparison against the original runtime
matched all 360 decoded Eric Andre frames across DVD and TV Broadcast samples.
This is picture parity for those samples, not live client acceptance or a new
throughput measurement. The Match HDR mode is not selected by this CRT path.

Only performance-mode Broadcast looks with a 1920x1080 active picture select
this route. Other sizes and looks retain the existing conversion. The shader,
pre-scale, grain, bloom, frame clock and output size stay unchanged. Libplacebo
produces NV12 directly with top-left point chroma, replacing the separate
`scale_vulkan` conversion. Point sampling matches the measured RGBA path but
can alias more than filtered downsampling; it is not a universal quality claim.

The storage runtime explicitly assumes the fp16 attachment truncation measured
on Intel ANV. It is not an automatic cross-driver choice. Unsupported storage
layouts/features use libplacebo's original output path. Unset
`TUNARR_CRT_DIRECT_NV12` to restore Tunarr's RGBA route on the next process;
unset the runtime values and `TUNARR_CRT_NV12_OUTPUT` as well to restore the
original runtime behavior.
No channel setting, schema, UI or shader changes are required.

## Mechanism

`VaapiOptions.ts` creates VAAPI from DRM, then derives Vulkan from that VAAPI
device. Deriving subtitle uploads back to VAAPI therefore reuses the video
device. Creating VAAPI and Vulkan as siblings instead allowed image subtitles
and video to reach the hardware overlay through separate VAAPI displays; the
observed result was stale/doubled video frames, despite valid output timestamps.
`CrtFilter.ts` maps decoded VAAPI frames to DRM, runs libplacebo's bundled shader
and aspect-correct scaling, then uses scale_vulkan and a reverse map to return
NV12 frames for VAAPI encoding. This avoids an explicit CPU frame download for
the effect. It is not a claim that the driver performs no GPU copies.

The ordinary runtime needs the scale_vulkan stage: removing it in the original
probe produced blank output even with a zero exit status. The opt-in runtime
corrects the imported target's attachment usage and separate-plane metadata.
VAAPI uploads elsewhere in this
pipeline explicitly derive their device when the global filter device is Vulkan.
Performance explicitly selects BT.709 as libplacebo's output matrix. Without
that selection, untagged SDR material failed RGB-to-NV12 conversion in scale_vulkan
with "Unsupported colorspace" during live verification. Standard is unchanged.
Subtitles and logos are applied after the effect, using their existing rendering
paths. Pillarboxing remains outside the CRT image.

The shader is embedded as `custom_shader_bin`, so packaged executables do not
need an external shader file. `crtLottesShader.ts` retains the license from the
[mpv-retro-shaders CRT-Lottes port](https://github.com/hhirtz/mpv-retro-shaders/blob/master/crt-lottes.glsl).
Subtle reduces scanline/mask/bloom strength and disables curvature. Classic Flat
uses scan hardness -6, mask dark/light 0.85/1.15, and bloom amount 3/64, with
curvature disabled. Its lighter mask preserves the scanlines while reducing the
vertical color stripes. These settings do not promise an exact perceptual
halfway point between Subtle and Strong. Classic Flat uses a
virtual scanline grid with one period per three active output rows, independent
of source resolution. Texture sampling retains the source detail; there is no
360-row intermediate resize. At 1080 output rows this gives 360 scanlines. The
grid follows the active picture before padding, so letterboxing does not change
the pitch. Subtle and Strong retain their source-row grids. Strong
retains the curved image and mask/bloom parameters, but fades unresolved curved
scanline modulation to its period mean to suppress broad sampling interference.

The shared final shader samples the color at the bent screen coordinate directly.
The imported port ignored its horizontal offsets, so its 3-, 5- and 7-tap kernels
computed normalized averages of that same color. Removing those redundant
calculations preserves the existing vertical scanline and bloom weights, their
sum order, curvature and mask. It does not introduce neighboring-pixel blur or
another shader pass. Floating-point rounding can differ slightly; this is not a
byte-identical output guarantee. See [issue #54](https://github.com/TacoRocket/tunarr/issues/54)
for the measured scope and the separately parked spatial-bloom experiments.

The frequency clamp in `crtLottesShader.ts` estimates the source-row footprint
of one output pixel analytically from the curvature transform. Curved scanline
weights fade between 0.25 and 0.5 source rows per output pixel; the mean is the
Gaussian integral over the shader's existing phase interval. This also filters
the bloom scan weights. It avoids screen derivatives, which are unavailable in
libplacebo compute shaders. Flat presets bypass this curvature filtering. The
clamp addresses spatial arcing; it does not synchronize GPU frame handoffs or
repair temporal frame corruption.

Classic Flat also runs `crtChromaBleedShader.ts` before the main CRT pass. This
is a normalized, horizontal Gaussian blur of the CHROMA plane: 31 samples across
three standard deviations on each side, with sigma fixed at six active output
pixels. It softens color edges while leaving source luminance untouched, to
approximate analog TV's lower horizontal color detail. `target_size.x` converts
output pixels into chroma texels; 4:3 pictures and widescreen ads therefore use
the same blur radius without resizing the source. Subtle and Strong do not use
this pass. Subtitles and padding still come afterward.

The CHROMA hook was verified on the DRM-prime NV12 path using a neutral-color
sentinel and measurements before encoding. The sigma-six probe matched the CPU
round-trip reference on all 360 Pepsi Blue frames. Paired single-stream samples
ran about 0–5% slower; constant-QP output size was effectively unchanged. Those
results are from the isolated reverse-wait FFmpeg build and do not establish
five-stream throughput, live transition behavior, or RGB-input hook support.
The probe used a fixed 1440-pixel active width; this implementation uses the
[libplacebo output rectangle](https://libplacebo.org/custom-shaders/) instead.

Classic Flat adds horizontal luma edge peaking in `crtLumaPeakingShader.ts`.
A five-tap binomial blur (weights 1/4/6/4/1, divided by 16) provides the local
brightness reference; the pass adds 1.5 times the original-minus-blurred signal
and clamps it to the valid range. Tap spacing is 2.4 active output pixels, with
an outer reach of 4.8 pixels, converted to input luma texels. The LUMA hook runs
before the CRT texture, so it sharpens picture outlines without sharpening the
mask or scanlines. The separate CHROMA pass still softens color boundaries.
Subtle and Strong do not use edge peaking. No new API or UI is introduced.

On the same 12-second, 360-frame SDR commercial probe, strength 1.5 matched the
CPU-roundtrip reference exactly. Five concurrent low-power encodes remained
about 7.35–7.41 times realtime aggregate with and without peaking. Constant-QP24
video bytes grew 7.31% relative to Classic Flat with color bleed alone: more
edge detail competes for the existing bitrate. This does not establish quality
on other sources, HDR or drivers, or long-running client playback reliability.

## Current boundary

DVD Broadcast and TV Broadcast prepend a VAAPI resize to 480 or 360 rows,
respectively, before the DRM/Vulkan handoff. Width follows the active target
aspect ratio and rounds to an even NV12 width (4:3 gives 640 or 480 pixels;
16:9 gives 854 or 640). Libplacebo restores the requested output dimensions
before the existing padding, subtitles and logos are applied. The channel's
output resolution and cadence stay unchanged; no global crop is added.

Both broadcast looks reuse Classic Flat's virtual scanline grid and sigma-six
chroma blur, with edge-peaking strength reduced to 0.75 and mask dark/light
reduced to 0.95/1.05. The three existing looks are unchanged. The extra resize
deliberately loses picture detail, including any captions already burned into
the source; separately rendered subtitles retain their output resolution.

- Requires VAAPI encoding, hardware filters, DRM/Vulkan interoperation, libplacebo
  and scale_vulkan. Enabling it for direct/remux modes or another configured
  hardware backend is rejected. Playback also checks the effective backend and
  required filters; no software-rendering fallback is claimed.
- SDR inputs retain their existing path. Eligible HDR10 inputs can use the
  DVD Broadcast path described below. Other HDR inputs log a bypass and retain
  existing tone mapping; CRT remains configured for later SDR programs.
- Measured on one Intel Alder Lake GPU with ErsatzTV FFmpeg 8.1.2-etv.4. The
  isolated native command exercise used a 720p 10-bit SDR HEVC excerpt, H.264
  output, both presets/modes, pillarboxing, a text subtitle and a static logo.
  This is not verification of every driver, codec, image-subtitle format, or
  live channel transition.
- No live channel enablement, UI, arbitrary shader input, other GPU backends,
  automatic fallback subsystem, or upstream contribution is included.

## HDR10 DVD Broadcast

`VaapiPipelineBuilder` can keep DVD Broadcast enabled for HDR10 when the existing
opt-ins select native NV12 CRT output and the VAAPI Hable LUT tone mapper:

- CRT enabled, `look: "dvd-broadcast"`, `processing: "performance"`.
- Active output image exactly 1920x1080, VAAPI hardware decoding and H.264
  hardware encoding, with hardware filters enabled.
- Tone mapping enabled and `TUNARR_VAAPI_HABLE_LUT=1`.
- `TUNARR_CRT_DIRECT_NV12=1`, `ETV_VAAPI_DIRECT_NV12=1`, and
  `TUNARR_CRT_NV12_OUTPUT=native`.
- Limited-range 10-bit PQ / BT.2020 input without Dolby Vision, and a runtime
  providing `tonemap_vaapi_lut` plus the existing CRT interop/filter support.
  These are custom runtime features; a stock FFmpeg build is not sufficient.

The pipeline first resizes the HDR picture to 854x480 in P010, then tone maps
that working image to SDR NV12, then applies the existing CRT shader at 1080p.
`CrtFilter` skips its usual pre-scale because the working image is already
prepared. Padding, separately rendered subtitles and logos still follow CRT.
The decoder continues to decode the full source; only subsequent filter work
shrinks. Early scaling can lose fine HDR highlight detail before tone mapping.

On one Intel Alder Lake GPU, two reordered 480-frame runs of a 4K HDR10 sample
averaged 76.5 fps versus 64.0 fps when tone mapping at 1080p before reducing to
480 lines: about 19% more throughput, or 16% less elapsed processing time.
Peak FFmpeg RSS changed from about 229 to 223 MiB. This compares two CRT
pipelines, not CRT against plain transcoding. The native generated graph also
encoded and decoded a 240-frame excerpt successfully as 1080p BT.709 H.264.
See [the scoped measurement record](../../../../../../plans/hdr-broadcast-crt-2026-10-30.md).

This is the tested portion of #36. TV Broadcast, other looks, OpenCL tone
mapping, HLG, Dolby Vision, software decoding and other active output dimensions
retain HDR bypass. There is no new setting or UI, and no deployment is implied.
Disable CRT to remove the effect; removing the LUT opt-in returns HDR to its
previous configured tone-mapping path with CRT bypass. Runtime failures remain
visible rather than silently switching pipelines.

## Optional Broadcast texture and grain

The existing `crt` object accepts `broadcastGrain: true` and
`broadcastTexture: "classic-flat"` for either Broadcast look. Grain defaults off;
texture defaults to `"light"`. Omitted fields retain the original rendered look.
The options have no effect on Subtle, Classic Flat or Strong. Updating `crt`
replaces that object: send both options when retaining both. No UI or extra preset
is introduced.

`broadcastTexture: "classic-flat"` restores mask dark/light to 0.85/1.15 while
retaining Broadcast's reduced 0.75 peaking and SD resize. `crtBroadcastGrainShader.ts`
adds animated monochrome triangular noise in a MAIN pass at the SD input size,
before upscale and CRT texture. Peak amplitude is 4/255, fading near black and
white. It uses a deterministic pixel/frame hash; this is a visual texture, not a
physical film-stock simulation. Subtitles and padding still follow the effect.

On a 20-second DBZ Kai 1080p remux action sample with restored mask, CQP 24 video
bytes grew 19.6% at 360 rows and 14.6% at 480 rows with light grain. Fixed 8 Mbps
retains its rate but has less quality headroom; busy red/action frames can show
mask breakup, somewhat worse with DVD grain. Five concurrent TV Broadcast
low-power encodes showed no measurable slowdown in paired runs. A 360-frame
Pepsi sample matched the CPU-roundtrip reference exactly. These bounded results
do not establish every source, driver or long-running client behavior. Existing
grainy sources may benefit from leaving grain off.

## Optional Broadcast composite and grain levels

The API-only `crt.broadcastComposite: true` enables the tested two-pass composite
signal encoder/decoder for the two Broadcast looks. It defaults off. Existing
`broadcastGrain: true` remains full strength (4/255); `"half"` selects 2/255;
`false` or omission disables grain. `broadcastTexture: "classic-flat"` retains
the existing stronger screen mask. Other looks ignore these Broadcast options.
No ghost, UI controls, FFmpeg changes, or subtitle-policy changes are included.

`crtBroadcastCompositeShader.ts` implements quadrature amplitude modulation and
synchronous demodulation, with Gaussian FIR low-pass filtering and a luma chroma
notch. It adapts Lola Retro commit
`2fa11513b01bd6ecbf67930abd6c2863cf251b79` (MIT; full notice in the shader).
The first pass saves the combined signal and oscillator reference at 1280 samples
per line. The second recovers color from that signal, before existing grain and
CRT treatment. Reference channels carry the oscillator, not separate source Y/C.
The model uses 3.579545 MHz and 52.6 microseconds of active-line timing, a 3.3 MHz
luma / 0.6 MHz chroma decoder, and a 0.92 notch. Tape/station bandwidths are borrowed
model choices, including the symmetric 1.3 MHz station color filter; they do not
prove the response of a particular NTSC station. Progressive row/frame phase and
existing picture geometry are retained. This is not a full interlaced decoder,
PAL delay line, historical phosphor/color model, RF receiver, or afterglow model.

`broadcastFrameClock.ts` owns the animation clock for this NV12-only path.
Libplacebo's `frame` increments for each executed hook, not each video frame.
The generator derives execution order from the selected unconditional LUMA,
CHROMA, and MAIN hooks; each animated pass receives a zero-based picture index.
Grain maps that index onto the original grain graph's sequence, so adding
composite or choosing half/full grain does not change its phase. The decoder
uses the encoder's saved oscillator reference. Conditional hooks or other input
stages are rejected by this clock resolver; supporting them would require revisiting
this invariant. Broadcast's preceding `scale_vaapi` guarantees NV12 input.

Only with `processing: "experimental"` and both composite and grain enabled,
the composite decoder applies the
shared grain function before returning its SD pixel. This is shader-pass fusion:
it removes the separate grain dispatch and intermediate texture, while retaining
the grain formula, half/full strength and original animation sequence through
`resolveBroadcastFrameClock`. Grain-only channels retain the standalone pass;
composite-only channels do not add grain. Omitted processing, `standard` and
`performance` keep the separate grain pass. Switching back restores that path.
The existing defaults and runtime opt-ins remain unchanged; Experimental does
not automatically enable media-engine settings. This is the grain gate for #72,
not the complete Quality/Performance preset rollout. The existing `performance`
name still means its legacy processing route, not the proposed offload tier.

Removing the intermediate texture also removes a rounding boundary. In short
comparisons on one Intel GPU, about 1.7–2.2% of 8-bit image values changed, almost
all by one code value. Matched stills and motion samples were accepted by the
operator before implementation. This is not bitwise equivalence or proof for all
sources and drivers. The companion records the bounded performance measurements;
the change does not claim additional stream capacity or power savings.

An isolated Linux VAAPI/Vulkan probe established matching GPU/CPU output, native
360/480 rendering and short-file decode behavior. Those checks do not establish
TV appearance or long-running TiviMate/UHF playback. Model and encoding costs are
content-dependent; the deployment companion owns measurements and client evidence.

## Broadcast display color

TV Broadcast and DVD Broadcast share the selected V5 display-color treatment.
`broadcastColor.ts` evaluates a pointwise RGB/HSV transform at the end of the
existing CRT hook, after composite, grain, softening and screen texture. It
warms reds/browns, lifts midtones, moderates pale neutrals and shifts saturated
blue/purple toward blue/cyan. It uses the V5 formula (78% of the V4 grade plus
the blue correction), rather than an external LUT file or a new GPU pass.

Only the two Broadcast looks use this treatment; Subtle, Classic Flat and
Strong remain unchanged. No channel schema, bitrate, cadence, grain selection,
subtitle rendering or animation-clock change is introduced. The local reference
was an operator-selected look compared with matched-setting phone captures of
a Sony CRT and LCD, not a calibrated phosphor model or an inverse camera profile.
The analytic transform can differ slightly from the interpolated 33-point LUT
used for the comparison videos.
