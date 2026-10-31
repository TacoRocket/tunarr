import { expect, it } from 'vitest';
import { decodePgs, renderPgs } from './PgsDecoder.ts';

// Final display from the direct-block probe: two ODS fragments, no later clear.
// Remuxing this input to SUP lost its stored Matroska BlockDuration.
const finalDisplay = Buffer.from(
  '160013014000b4100004800000010000000000640096' +
    '17000a01000064009600080002' +
    '14000c0000001080800001eb8080ff' +
    '150015000000800000180008000201010101010101010000' +
    '15000e0000004001010101010101010000' +
    '800000',
  'hex',
);

it('preserves the stored final duration that the SUP handoff discarded', () => {
  const cues = decodePgs([
    {
      timestampNs: 7_250_000_000n,
      durationNs: 1_625_000_000n,
      data: finalDisplay,
    },
  ]);
  expect(cues.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
    { startMs: 7250, endMs: 8875 },
  ]);
});

it('keeps the missing-duration counterpart unresolved', () => {
  const cues = decodePgs([
    { timestampNs: 7_250_000_000n, durationNs: null, data: finalDisplay },
  ]);
  expect(cues.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
    { startMs: 7250, endMs: null },
  ]);
});

function displaySet(milliseconds: number, clear = false) {
  const segment = (kind: number, hex: string) => {
    const data = Buffer.from(hex, 'hex');
    const header = Buffer.alloc(3);
    header[0] = kind;
    header.writeUInt16BE(data.length, 1);
    return Buffer.concat([header, data]);
  };
  // A three-pixel white object at (10,20), then transparent/gray at (11,20).
  const picture = clear
    ? '0014002800000080000000'
    : '001400280000008000000200000000000a001400010000000b0014';
  return {
    timestampNs: BigInt(milliseconds) * 1_000_000n,
    durationNs: null,
    data: Buffer.concat([
      segment(0x16, picture),
      ...(clear
        ? []
        : [
            segment(0x14, '0000001080800001eb8080ff027e8080ff'),
            segment(0x15, '000000c0000009000300010083010000'),
            segment(0x15, '000100c000000a00020001008100020000'),
          ]),
      segment(0x80, ''),
    ]),
  };
}

it('retains text under transparent overlapping objects through fade merging', () => {
  // Plain row copying erases the second white pixel. This is the concrete
  // counterexample to replacing the previous Skia source-over operation with copy.
  const blocks = [0, 1000, 2000].flatMap((start) => [
    displaySet(start),
    displaySet(start + 100),
    displaySet(start + 200, true),
  ]);
  const cues = decodePgs(blocks);
  expect(cues.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
    [0, 200],
    [1000, 1200],
    [2000, 2200],
  ]);
  for (const cue of cues) {
    expect(renderPgs(cue)).toEqual({
      width: 3,
      height: 1,
      pixels: Buffer.from([
        255, 255, 255, 255, 255, 255, 255, 255, 128, 128, 128, 255,
      ]),
    });
  }
});
