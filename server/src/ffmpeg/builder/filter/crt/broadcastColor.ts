// Pointwise V5 display-color treatment, evaluated after the existing CRT pass.
// No additional hook: the composite/grain pass count and animation clock stay fixed.
export const broadcastColorFunctions = String.raw`
vec3 broadcast_rgb_to_hsv(vec3 color) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(color.bg, K.wz), vec4(color.gb, K.xy), step(color.b, color.g));
    vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 broadcast_hsv_to_rgb(vec3 hsv) {
    vec3 p = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return hsv.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), hsv.y);
}

vec3 broadcast_v5_color(vec3 input_color) {
    vec3 original = clamp(input_color, 0.0, 1.0);
    vec3 hsv = broadcast_rgb_to_hsv(original);
    float hue = mod(hsv.x * 360.0 + 180.0, 360.0) - 180.0;
    float chroma = smoothstep(0.10, 0.25, hsv.y);
    float reds = smoothstep(-28.0, -16.0, hue) * (1.0 - smoothstep(23.0, 25.0, hue));
    float browns = smoothstep(23.0, 25.0, hue) * (1.0 - smoothstep(50.0, 58.0, hue));
    float shifted = hue + chroma * (reds * 0.75 * (13.0 - hue) + browns * 0.70 * (32.0 - hue));
    float warm = clamp(browns + 0.35 * reds * smoothstep(8.0, 16.0, hue), 0.0, 1.0);
    float saturation = clamp(hsv.y * (1.0 + 0.28 * warm * smoothstep(0.24, 0.38, hsv.y)), 0.0, 1.0);
    float neutral = (1.0 - smoothstep(0.22, 0.40, hsv.y)) * smoothstep(0.45, 0.75, hsv.z);
    saturation *= 1.0 - 0.80 * neutral;
    vec3 color = broadcast_hsv_to_rgb(vec3(fract(shifted / 360.0 + 1.0), saturation, hsv.z));
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float lifted = pow(clamp(luma, 0.0, 1.0), 0.80);
    color *= luma > 1e-4 ? lifted / max(luma, 1e-4) : 1.0;
    float peak = max(color.r, max(color.g, color.b));
    if (peak > 1.0) {
        color = vec3(lifted) + (color - lifted) * ((1.0 - lifted) / max(peak - lifted, 1e-6));
    }
    float shadows = 1.0 - smoothstep(0.04, 0.25, lifted);
    color = clamp(color * (vec3(1.0) + shadows * vec3(0.06, 0.03, -0.10)), 0.0, 1.0);
    color = mix(original, color, 0.78);
    hsv = broadcast_rgb_to_hsv(color);
    hue = hsv.x * 360.0;
    float blues = smoothstep(185.0, 205.0, hue) * (1.0 - smoothstep(285.0, 300.0, hue)) * smoothstep(0.12, 0.28, hsv.y);
    hue -= blues * (hue < 240.0 ? 12.0 : 16.0);
    return clamp(broadcast_hsv_to_rgb(vec3(fract(hue / 360.0 + 1.0), hsv.yz)), 0.0, 1.0);
}
`;
