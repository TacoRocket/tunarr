export const KnownFfmpegOptions = {
  ReadrateInitialBurst: 'readrate_initial_burst',
  ReadrateCatchup: 'readrate_catchup',
  GpuCopy: 'gpu_copy',
} as const;

// Reference peak for filters with a `peak` override. This replaces the
// metadata-derived peak, but does not disable OpenCL's scene adaptation.
// TODO: derive this per-title from probed mastering-display/CLL metadata
// (not currently captured by ffprobe parsing) and fall back to this
// constant when absent.
export const DefaultTonemapPeakNits = 1000;

// ffmpeg's `tonemap` and `tonemap_opencl` filters take `peak` as a multiple
// of reference white (REFERENCE_WHITE = 100 nits in libavfilter), not in
// nits. Linear light is scaled the same way: zscale's npl=100 and
// tonemap_opencl's PQ EOTF both put 1.0 at 100 nits.
export const TonemapReferenceWhiteNits = 100;

export function toFfmpegTonemapPeak(peakNits: number): number {
  return peakNits / TonemapReferenceWhiteNits;
}

export const KnownFfmpegFilters = {
  ScaleNpp: 'scale_npp',
  ScaleCuda: 'scale_cuda',
  ScaleVulkan: 'scale_vulkan',
  TonemapVaapi: 'tonemap_vaapi',
  TonemapVaapiLut: 'tonemap_vaapi_lut',
  TonemapOpencl: 'tonemap_opencl',
  Libplacebo: 'libplacebo',
  PadVaapi: 'pad_vaapi',
  PadOpencl: 'pad_opencl',
  OverlayQsv: 'overlay_qsv',
};
