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

`look` accepts `subtle`, `classic-flat`, or `strong`. `processing` accepts `standard` (NV12
intermediate) or `performance` (RGBA intermediate). Defaults when enabled are
subtle/performance. Performance can change fine color and mask texture slightly;
standard is the closer match to the original NV12 experiment, not a promise of
unaltered source colors. Both use the same shader preset.

Omitting `crt` on an update preserves the saved setting. `null` clears it, and
`enabled: false` disables it while retaining the chosen options. Existing channels
start disabled. Changes take effect when the next stream session loads the channel
settings; already-running FFmpeg processes are not restarted by this setting.

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

The scale_vulkan stage is necessary: removing it in the isolated probe produced
blank output even with a zero exit status. VAAPI uploads elsewhere in this
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

- Requires VAAPI encoding, hardware filters, DRM/Vulkan interoperation, libplacebo
  and scale_vulkan. Enabling it for direct/remux modes or another configured
  hardware backend is rejected. Playback also checks the effective backend and
  required filters; no software-rendering fallback is claimed.
- SDR inputs only. HDR inputs log a bypass and retain the existing tone-mapping
  pipeline. CRT remains configured for later SDR programs.
- Measured on one Intel Alder Lake GPU with ErsatzTV FFmpeg 8.1.2-etv.4. The
  isolated native command exercise used a 720p 10-bit SDR HEVC excerpt, H.264
  output, both presets/modes, pillarboxing, a text subtitle and a static logo.
  This is not verification of every driver, codec, image-subtitle format, or
  live channel transition.
- No live channel enablement, UI, arbitrary shader input, other GPU backends,
  automatic fallback subsystem, or upstream contribution is included.
