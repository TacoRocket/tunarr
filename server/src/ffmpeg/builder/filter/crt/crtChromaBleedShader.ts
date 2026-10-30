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

export function createPairedChromaBleedShader(
  chromaWidth: number,
  outputWidth: number,
): string {
  if (
    !Number.isInteger(chromaWidth) ||
    !Number.isInteger(outputWidth) ||
    chromaWidth <= 0 ||
    outputWidth <= 0
  ) {
    return crtChromaBleedShader;
  }

  const radius = Math.ceil((3 * sigma * chromaWidth) / outputWidth);
  if (radius >= taps.length - 1) return crtChromaBleedShader;

  // Preserve the original shader's rounded coefficients, distributing each
  // fractional lookup onto the two source texels its linear sampler reads.
  const weights = new Map<number, number>();
  for (const tap of taps) {
    const position =
      (Number(tap.offset.toFixed(8)) * chromaWidth) / outputWidth;
    const left = Math.floor(position);
    const fraction = position - left;
    const weight = Number((tap.weight / totalWeight).toFixed(10));
    weights.set(left, (weights.get(left) ?? 0) + weight * (1 - fraction));
    weights.set(left + 1, (weights.get(left + 1) ?? 0) + weight * fraction);
  }

  // Adjacent texels with weights a/b can share one bilinear lookup at b/(a+b).
  const pairedSamples: string[] = [];
  for (let left = -radius; left <= radius; left += 2) {
    const a = weights.get(left) ?? 0;
    const b = weights.get(left + 1) ?? 0;
    const weight = a + b;
    if (weight === 0) continue;
    const offset = left + b / weight;
    pairedSamples.push(
      `${weight.toFixed(12)} * HOOKED_texOff(vec2(${offset.toFixed(12)}, 0.0))`,
    );
  }

  return crtChromaBleedShader.replace(
    'vec4 hook() {',
    `vec4 hook() {
  if (HOOKED_size.x == ${chromaWidth.toFixed(1)} && target_size.x == ${outputWidth.toFixed(1)}) {
    return ${pairedSamples.join(' +\n      ')};
  }`,
  );
}
