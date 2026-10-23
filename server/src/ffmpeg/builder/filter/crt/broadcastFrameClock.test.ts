import { resolveBroadcastFrameClock } from './broadcastFrameClock.ts';

const planes = '//!HOOK LUMA\nluma;\n//!HOOK CHROMA\nchroma;\n';
const grain = '//!HOOK MAIN\nseed = BROADCAST_GRAIN_FRAME;\n';
const crt = '//!HOOK MAIN\ncrt;\n';
const reference = grain + planes + crt;

function evaluate(shader: string, name: string, frame: number): number {
  const expression = shader.match(new RegExp(`${name} = (.+);`))?.[1];
  if (expression === undefined) throw new Error(`Missing ${name}`);
  return Number(new Function('frame', `return ${expression}`)(frame));
}

test('composite phase advances once per picture with grain enabled or disabled', () => {
  const encode = '//!HOOK MAIN\nphase = BROADCAST_FRAME_INDEX;\n';
  const decode = '//!HOOK MAIN\ndecode;\n';
  for (const enabled of [false, true]) {
    const shader = resolveBroadcastFrameClock(
      encode + decode + (enabled ? grain : '') + planes + crt,
      reference,
    );
    const executionsPerPicture = enabled ? 6 : 5;
    for (let picture = 0; picture < 4; picture++) {
      expect(
        evaluate(shader, 'phase', picture * executionsPerPicture + 3),
      ).toBe(picture);
    }
  }
});

test('grain retains the original animation sequence after MAIN hooks are inserted', () => {
  for (const additions of [0, 1, 2, 3]) {
    const extra = '//!HOOK MAIN\nextra;\n'.repeat(additions);
    const shader = resolveBroadcastFrameClock(extra + reference, reference);
    for (let picture = 0; picture < 4; picture++) {
      expect(
        evaluate(shader, 'seed', picture * (4 + additions) + 3 + additions),
      ).toBe(picture * 4 + 3);
    }
  }
});
