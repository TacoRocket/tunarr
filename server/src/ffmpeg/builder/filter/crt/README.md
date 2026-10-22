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

`VaapiOptions.ts` creates VAAPI and Vulkan devices from a shared DRM parent.
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
uses the parameter midpoints between Subtle and Strong with curvature disabled:
scan hardness -6, mask dark/light 0.7/1.3, and bloom amount 3/64. These parameter
midpoints do not promise an exact perceptual halfway point. Classic Flat uses a
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
