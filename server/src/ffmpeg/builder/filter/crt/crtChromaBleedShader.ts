const sigma = 6;
const taps = Array.from({ length: 31 }, (_, index) => {
  const distance = (index - 15) / 5;
  return {
    offset: distance * sigma,
    weight: Math.exp(-0.5 * distance * distance),
  };
});
const totalWeight = taps.reduce((sum, tap) => sum + tap.weight, 0);
const samples = taps.map(
  ({ offset, weight }) =>
    `${(weight / totalWeight).toFixed(10)} * HOOKED_texOff(vec2(${offset.toFixed(8)} * HOOKED_size.x / target_size.x, 0.0))`,
);

// CHROMA runs before RGB conversion, leaving source luma untouched. Convert
// output-pixel offsets into chroma texels so the blur does not depend on input size.
export const crtChromaBleedShader = `
//!HOOK CHROMA
//!BIND HOOKED
//!DESC Horizontal chroma bleed (sigma 6 output pixels)
vec4 hook() {
  return ${samples.join(' +\n    ')};
}
`;
