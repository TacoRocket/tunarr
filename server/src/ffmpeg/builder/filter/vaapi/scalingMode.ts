// Explicit default lets the driver select its dedicated scaler instead of FFmpeg's HQ request.
export function vaapiScalingModeOption(
  preferDedicatedScaler = process.env.TUNARR_VAAPI_DEFAULT_SCALING === '1',
): string {
  return preferDedicatedScaler ? ':mode=default' : '';
}
