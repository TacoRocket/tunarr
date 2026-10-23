export const crtBroadcastCompositeShader = String.raw`// Adapted from Lola Retro encode/decode at 2fa11513b01bd6ecbf67930abd6c2863cf251b79.
// MIT License
//
// Copyright (c) 2026 Zoki
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//!HOOK MAIN
//!BIND HOOKED
//!SAVE COMPOSITE
//!WIDTH 1280
//!HEIGHT HOOKED.h
//!COMPONENTS 4
//!DESC Broadcast composite encoder
float carrier(float n, float row) {
 return 6.28318530718 * (3.579545 * n * 52.6 / 1280.0 + 0.5 * mod(row + float(BROADCAST_FRAME_INDEX), 2.0));
}
vec4 hook() {
 float n = floor(HOOKED_pos.x * 1280.0);
 float row = floor(HOOKED_pos.y * HOOKED_size.y);
 float clockMHz = HOOKED_size.x / 52.6;
 float sigmaY = 0.1325 * sqrt(2.0) / 5.5 * clockMHz;
 float sigmaC = 0.1325 * sqrt(2.0 / (2.1 * 2.1) + 1.0 / (1.3 * 1.3)) * clockMHz;
 float Y = 0.0; vec2 uv = vec2(0.0); float total = 0.0;
 for (int k = -8; k <= 8; k++) {
  float u = float(k) * 0.4, w = exp(-0.5 * u * u);
  vec3 cy = HOOKED_texOff(vec2(u * sigmaY, 0.0)).rgb;
  vec3 cc = HOOKED_texOff(vec2(u * sigmaC, 0.0)).rgb;
  float yc = dot(cc, vec3(0.299, 0.587, 0.114));
  Y += w * dot(cy, vec3(0.299, 0.587, 0.114));
  uv += w * vec2(0.492 * (cc.b - yc), 0.877 * (cc.r - yc));
  total += w;
 }
 Y /= total; uv /= total;
 float phase = carrier(n,row);
 float signal = Y + uv.x * sin(phase) + uv.y * cos(phase);
 return vec4(signal,sin(phase),cos(phase),1.0);
}

//!HOOK MAIN
//!BIND HOOKED
//!BIND COMPOSITE
//!DESC Broadcast composite synchronous decoder
vec3 signalAt(float n, float row) {
 return COMPOSITE_tex(vec2((clamp(n,0.0,1279.0)+0.5)/1280.0,(row+0.5)/COMPOSITE_size.y)).rgb;
}
vec4 hook() {
 float n = floor(HOOKED_pos.x * 1280.0);
 float row = floor(HOOKED_pos.y * HOOKED_size.y);
 float fs = 1280.0 / 52.6;
 float sigY = 0.1325 / 3.3 * fs;
 float sigC = 0.1325 / 0.6 * fs;
 float Y = 0.0, wy = 0.0, wc = 0.0; vec2 uv = vec2(0.0);
 for (int k = -4; k <= 4; k++) {
  float t = float(k); float w = exp(-0.5*t*t/(sigY*sigY));
  Y += w * signalAt(n+t,row).r; wy += w;
 }
 for (int k = -17; k <= 17; k++) {
  float t = float(k); float w = exp(-0.5*t*t/(sigC*sigC));
  vec3 sampleValue = signalAt(n+t,row);
  uv += w * sampleValue.r * sampleValue.gb; wc += w;
 }
 Y /= wy; uv *= 2.0 / wc;
 vec2 reference = signalAt(n,row).gb;
 float response = exp(-19.7392 * pow(0.1325/3.3 * 3.579545,2.0));
 Y -= 0.92 * response * dot(uv,reference);
 vec3 rgb = vec3(Y + 1.13983*uv.y, Y - 0.39465*uv.x - 0.58060*uv.y, Y + 2.03211*uv.x);
 return vec4(clamp(rgb,0.0,1.0),HOOKED_texOff(vec2(0.0)).a);
}

`;
