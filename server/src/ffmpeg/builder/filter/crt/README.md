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

`look` accepts `subtle` or `strong`. `processing` accepts `standard` (NV12
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
Subtitles and logos are applied after the effect, using their existing rendering
paths. Pillarboxing remains outside the CRT image.

The shader is embedded as `custom_shader_bin`, so packaged executables do not
need an external shader file. `crtLottesShader.ts` retains the license from the
[mpv-retro-shaders CRT-Lottes port](https://github.com/hhirtz/mpv-retro-shaders/blob/master/crt-lottes.glsl).
The subtle preset reduces scanline/mask/bloom strength and disables curvature;
strong uses that port's defaults.

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
