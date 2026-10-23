// Broadcast always supplies NV12: LUMA and CHROMA run before MAIN. libplacebo's
// `frame` counts hook executions, so each animated pass needs its own ordinal.
function passes(shader: string) {
  const matches = [...shader.matchAll(/^\/\/!HOOK (\w+)$/gm)];
  const order = ['LUMA', 'CHROMA', 'MAIN'];
  const result = matches.map((match, index) => {
    const stage = order.indexOf(match[0].slice('//!HOOK '.length));
    const text = shader.slice(match.index, matches[index + 1]?.index);
    if (stage < 0 || /^\/\/!WHEN /m.test(text)) {
      throw new Error(
        'Broadcast clock requires unconditional NV12 shader hooks',
      );
    }
    return { stage, text };
  });
  const execution = [...result].sort((a, b) => a.stage - b.stage);
  return result.map((pass) => ({
    ...pass,
    ordinal: execution.indexOf(pass) + 1,
  }));
}

export function resolveBroadcastFrameClock(
  shader: string,
  grainReference: string,
): string {
  const selected = passes(shader);
  const reference = passes(grainReference);
  const grain = reference.find((pass) =>
    pass.text.includes('BROADCAST_GRAIN_FRAME'),
  );
  if (grain === undefined) {
    throw new Error('Broadcast grain reference has no animation clock');
  }
  // Keep the shipped grain sequence, deriving its stride/phase from the original
  // grain graph instead of tying them to the current option combination.
  for (const pass of selected) {
    const imageFrame = `((frame - ${pass.ordinal}) / ${selected.length})`;
    const resolved = pass.text
      .replaceAll('BROADCAST_FRAME_INDEX', imageFrame)
      .replaceAll(
        'BROADCAST_GRAIN_FRAME',
        `(${imageFrame} * ${reference.length} + ${grain.ordinal})`,
      );
    shader = shader.replace(pass.text, resolved);
  }
  return shader;
}
