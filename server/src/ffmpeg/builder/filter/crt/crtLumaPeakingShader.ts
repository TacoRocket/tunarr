// Apply edge peaking to source luma before the CRT mask and scanline texture.
export const crtLumaPeakingShader = `//!HOOK LUMA
//!BIND HOOKED
//!DESC Horizontal TV edge peaking
vec4 hook() {
 vec4 center = HOOKED_texOff(vec2(0.0));
 float stepX = 2.4 * HOOKED_size.x / target_size.x;
 float blurred = (HOOKED_texOff(vec2(-2.0 * stepX, 0.0)).r + 4.0 * HOOKED_texOff(vec2(-stepX, 0.0)).r + 6.0 * center.r + 4.0 * HOOKED_texOff(vec2(stepX, 0.0)).r + HOOKED_texOff(vec2(2.0 * stepX, 0.0)).r) / 16.0;
 center.r = clamp(center.r + 1.5 * (center.r - blurred), 0.0, 1.0);
 return center;
}
`;
