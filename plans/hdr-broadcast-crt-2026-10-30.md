# HDR10 DVD Broadcast: early-downscale candidate

Status: implemented for PR review; not merged or deployed. Related to #36,
which remains open for HDR paths outside this candidate.

## Change and invariant

An HDR program previously bypassed the configured CRT effect. The bounded path
in `VaapiPipelineBuilder` now keeps DVD Broadcast for the existing native-NV12,
VAAPI Hable LUT opt-ins when hardware decoding and H.264 encoding are available
and the active output image is 1920x1080. The existing LUT eligibility check owns
HDR10 format selection. No API, schema, dependency, wrapper or ad-pod changes.

The invariant is SDR input at the CRT shader, without an extra redundant resize:
HDR decode -> VAAPI 854x480 P010 -> Hable LUT to SDR NV12 -> existing CRT at
1920x1080 -> existing padding/overlays/output. Explicit P010 is necessary because
the decoder state can describe the 10-bit surface as `yuv420p10le`, which is not
the required VAAPI scaler output format. SDR retains its existing path; other
HDR modes retain tone mapping with CRT bypass.

## Evidence and alternatives

Tests used one Intel i3-1220P / Alder Lake GPU with the existing custom ErsatzTV
FFmpeg 8.1.2-etv.dev.fd620cfb runtime, a 3840x2160 HEVC Main10 limited-range
PQ BT.2020 source, 1080p H.264 output at 8 Mbps, DVD Broadcast, composite enabled
and half-strength grain. The reference and candidate use identical shaders and
native NV12 box chroma downscaling. VAAPI scaling used `mode=default` for the
performance comparison. Two 480-frame runs per path were reordered.

| Measurement                  | Tone map at 1080p, then CRT at 480 lines | Resize HDR to 480 lines, then tone map and CRT |
| ---------------------------- | ---------------------------------------: | ---------------------------------------------: |
| Mean throughput              |                                64.04 fps |                                      76.46 fps |
| Mean CPU time per 480 frames |                                  3.396 s |                                        3.097 s |
| Peak FFmpeg RSS              |                                228.7 MiB |                                      223.4 MiB |

The gain is about 19% throughput / 16% elapsed time / 9% CPU time, not a claim
of a large memory reduction or whole-container savings. Full-resolution decode,
1080p CRT output and encoding still cost work. Plain HDR transcoding remains
cheaper than adding CRT.

A combined libplacebo tone-mapping prototype did not improve the initial
throughput comparison. Moving its RGB hooks after tone mapping required an RGBA
intermediate to correct a color cast and reduced throughput to about 44 fps.
Those results describe the prototypes tested, not every possible libplacebo
implementation. This PR retains the existing shader and LUT mechanism.

Two aligned 240-frame motion pairs had matching frame counts and timestamps;
best relative frame alignment was zero. Three identical decoded source frames
fed to both paths differed by about 0.73-0.80 mean absolute 8-bit luma values,
with 99th-percentile absolute differences of 7-8. Color differences were small
in the displayed samples. The operator accepted the comparison visually; this
is not calibrated color validation. Early HDR scaling can discard fine highlight
detail before tone mapping.

## Native validation and limits

- The unit regression checks early P010 scaling, LUT-before-CRT ordering, no
  duplicate pre-scale, hardware interop and the unchanged SDR control.
- The exact filter graph emitted by the native test fixture was exercised in a
  disposable container using the deployed FFmpeg runtime, without the playback
  wrapper. It encoded 240 frames; ffprobe confirmed 1920x1080, yuv420p, BT.709,
  24000/1001 fps; a strict decode completed without errors. This exercised the
  generated graph with a real input and bounded output arguments, not a rebuilt
  Tunarr application or its live session lifecycle.
- Earlier isolated probes checked text subtitle rendering and SDR playback.
  Actual PGS lifecycle, live channel transitions, sustained playback, other GPUs
  and all HDR/CRT combinations remain unverified.

Private commands, logs and comparison media are retained in the deployment
companion under `deployment/hdr-crt-comparison-20261030/`. Public source contains
no media, local library paths or deployment identifiers. Rollback is one source
commit revert; no persistent data changes are involved.
