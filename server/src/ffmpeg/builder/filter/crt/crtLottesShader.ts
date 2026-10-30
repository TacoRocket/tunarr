// Bundled mpv CRT-Lottes shader. License and attribution are retained below.
export const crtLottesShader = String.raw`// Port of Timothy Lottes' CRT shader.
// The original shader is in the public domain.
//
// Copyright (c) 2022, The mpv-retro-shaders Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

//!HOOK MAIN
//!BIND MAIN
//!WIDTH OUTPUT.w
//!HEIGHT OUTPUT.h
//!DESC CRT Lottes

// Parameters
#define HARD_SCAN -8.0
#define SCANLINE_ROWS MAIN_size.y
#define CURVATURE vec2(0.031, 0.041)
#define MASK_DARK 0.5
#define MASK_LIGHT 1.5
#define SHADOW_MASK 2
#define BRIGHTNESS_BOOST 1.0
#define HARD_BLOOM_SCAN -2.0
#define BLOOM_AMOUNT (1.0/16.0)
#define SHAPE 2.0


#ifndef linearize
// Implementation from mpv's gpu-next
vec4 linearize(vec4 color) {
	const float _const_0_1 = 0.05958483740687370300;
	const float _const_1_1 = 0.87031054496765136718;
	color.rgb = max(color.rgb, 0.0);
	color.rgb = _const_1_1 * pow(color.rgb + vec3(_const_0_1), vec3(2.4));
	return color;
}
#endif

#ifndef delinearize
// Implementation from mpv's gpu-next
vec4 delinearize(vec4 color) {
	const float _const_0_2 = 0.05958483740687370300;
	const float _const_1_2 = 1.14901518821716308593;
	color.rgb = max(color.rgb, 0.0);
	color.rgb = pow(_const_1_2 * color.rgb, vec3(1.0/2.4)) - vec3(_const_0_2);
	return color;
}
#endif

// The imported horizontal taps all sampled pos; keep that picture without
// recomputing normalized weighted averages of the same color.
vec3 sample_linear_color(vec2 pos) {
	vec3 color = BRIGHTNESS_BOOST * MAIN_tex(pos).rgb;
	return linearize(vec4(color, 1.0)).rgb;
}

vec2 distance_to_texel(vec2 pos) {
	return -1.0 * fract(pos * vec2(MAIN_size.x, SCANLINE_ROWS) - vec2(0.5));
}

float gauss1d(float pos, float scale) {
	return exp2(scale * pow(abs(pos), SHAPE));
}

vec2 bend_screen(vec2 pos) {
	pos = pos * 2.0 - 1.0;
	pos *= vec2(1.0 + (pos.y * pos.y) * CURVATURE.x, 1.0 + (pos.x * pos.x) * CURVATURE.y);
	return pos * 0.5 + 0.5;
}

// Frequency clamping: replace unresolved curved scanlines with their period mean.
// The analytic footprint also works in libplacebo's compute shaders (no dFdx).
float scanline_visibility() {
	if (all(equal(CURVATURE, vec2(0.0)))) {
		return 1.0;
	}
	vec2 screen = MAIN_pos * 2.0 - 1.0;
	float row_dx = MAIN_size.y * 2.0 * screen.x * screen.y * CURVATURE.y / target_size.x;
	float row_dy = MAIN_size.y * (1.0 + screen.x * screen.x * CURVATURE.y) / target_size.y;
	float footprint = abs(row_dx) + abs(row_dy);
	return 1.0 - smoothstep(0.25, 0.5, footprint);
}

float gaussian_erf(float value) {
	float x = abs(value);
	float t = 1.0 / (1.0 + 0.3275911 * x);
	float polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
	return sign(value) * (1.0 - polynomial * exp(-x * x));
}

float filtered_scan(vec2 pos, float off, float scale) {
	float dst = distance_to_texel(pos).y;
	float weight = gauss1d(dst + off, scale);
	float visibility = scanline_visibility();
	if (visibility == 1.0) {
		return weight;
	}
	// SHAPE is 2: integrate exp(-k*x*x) over the existing [-1, 0] phase.
	float root_k = sqrt(-scale * log(2.0));
	float mean_weight = sqrt(3.141592653589793) / (2.0 * root_k)
		* (gaussian_erf(root_k * off) - gaussian_erf(root_k * (off - 1.0)));
	return mix(mean_weight, weight, visibility);
}

float scan(vec2 pos, float off) {
	return filtered_scan(pos, off, HARD_SCAN);
}

vec3 tri(vec2 pos) {
	vec3 color = sample_linear_color(pos);

	float wa = scan(pos, -1.0);
	float wb = scan(pos, 0.0);
	float wc = scan(pos, 1.0);

	return color * wa + color * wb + color * wc;
}

float bloom_scan(vec2 pos, float off) {
	return filtered_scan(pos, off, HARD_BLOOM_SCAN);
}

vec3 bloom(vec2 pos) {
	vec3 color = sample_linear_color(pos);

	float wa = bloom_scan(pos, -2.0);
	float wb = bloom_scan(pos, -1.0);
	float wc = bloom_scan(pos, 0.0);
	float wd = bloom_scan(pos, 1.0);
	float we = bloom_scan(pos, 2.0);

	return color * wa + color * wb + color * wc + color * wd + color * we;
}

vec3 mask(vec2 pos) {
	vec3 m = vec3(MASK_DARK, MASK_DARK, MASK_DARK);

	if (SHADOW_MASK == 1) {
		float line = MASK_LIGHT;
		float odd = 0.0;
		if (fract(pos.x / 6.0) < 0.5) {
			odd = 1.0;
		}
		if (fract((pos.y + odd) / 2.0) < 0.5) {
			line = MASK_DARK;
		}
		pos.x = fract(pos.x / 3.0);
		if (pos.x < 1.0 / 3.0) {
			m.r = MASK_LIGHT;
		} else if (pos.x < 2.0 / 3.0) {
			m.g = MASK_LIGHT;
		} else {
			m.b = MASK_LIGHT;
		}
		m *= line;
	} else if (SHADOW_MASK == 2) {
		pos.x = fract(pos.x / 3.0);
		if (pos.x < 1.0 / 3.0) {
			m.r = MASK_LIGHT;
		} else if (pos.x < 2.0 / 3.0) {
			m.g = MASK_LIGHT;
		} else {
			m.b = MASK_LIGHT;
		}
	} else if (SHADOW_MASK == 3) {
		pos.x += pos.y * 3.0;
		pos.x = fract(pos.x / 6.0);
		if (pos.x < 1.0 / 3.0) {
			m.r = MASK_LIGHT;
		} else if (pos.x < 2.0 / 3.0) {
			m.g = MASK_LIGHT;
		} else {
			m.b = MASK_LIGHT;
		}
	} else if (SHADOW_MASK == 4) {
		pos = floor(pos * vec2(1.0, 0.5));
		pos.x += pos.y * 3.0;
		pos.x = fract(pos.x / 6.0);
		if (pos.x < 1.0 / 3.0) {
			m.r = MASK_LIGHT;
		} else if (pos.x < 2.0 / 3.0) {
			m.g = MASK_LIGHT;
		} else {
			m.b = MASK_LIGHT;
		}
	}

	return m;
}

vec4 hook() {
	vec2 pos = bend_screen(MAIN_pos);
	vec3 color = tri(pos);

	color += bloom(pos) * BLOOM_AMOUNT;

	#if SHADOW_MASK != 0
	color *= mask(floor(MAIN_pos * target_size) + vec2(0.5, 0.5));
	#endif

	uint in_bounds = uint(0.0 <= pos.x && pos.x <= 1.0 && 0.0 <= pos.y && pos.y <= 1.0);
	return in_bounds * delinearize(vec4(color, 1.0));
}
`;
