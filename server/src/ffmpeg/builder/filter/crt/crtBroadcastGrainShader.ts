export function createBroadcastGrainFunctions(half = false): string {
  return `float grain_hash(uvec3 p) {
 uint n = p.x * 1973u + p.y * 9277u + p.z * 26699u + 911u;
 n = (n ^ (n >> 16u)) * 2246822519u;
 n = (n ^ (n >> 13u)) * 3266489917u;
 n = n ^ (n >> 16u);
 return float(n & 0x00ffffffu) / 16777216.0;
}
vec4 apply_broadcast_grain(vec4 c) {
 uvec2 pixel = uvec2(floor(HOOKED_pos * HOOKED_size));
 float n = grain_hash(uvec3(pixel, uint(BROADCAST_GRAIN_FRAME))) + grain_hash(uvec3(pixel, uint(BROADCAST_GRAIN_FRAME) + 7919u)) - 1.0;
 float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
 float envelope = smoothstep(0.02, 0.10, y) * (1.0 - smoothstep(0.90, 1.0, y));
 c.rgb = clamp(c.rgb + vec3(n * (${half ? '2.0' : '4.0'} / 255.0) * envelope), 0.0, 1.0);
 return c;
}

`;
}

// Grain-only channels retain their SD pass before the CRT upscale.
export const crtBroadcastGrainShader = `//!HOOK MAIN
//!BIND HOOKED
//!DESC SD monochrome grain
${createBroadcastGrainFunctions()}
vec4 hook() {
 return apply_broadcast_grain(HOOKED_texOff(vec2(0.0)));
}

`;
