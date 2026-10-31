import { expect, it } from 'vitest';
import { decodePgs } from './PgsDecoder.ts';

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
