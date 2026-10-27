// Explicit default lets the driver select its dedicated scaler instead of FFmpeg's HQ request.
export function vaapiScalingModeOption(): string {
  return process.env.TUNARR_VAAPI_DEFAULT_SCALING === '1'
    ? ':mode=default'
    : '';
}
