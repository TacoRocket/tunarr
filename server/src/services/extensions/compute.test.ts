import { expect, it } from 'vitest';
import { loadComputeModule } from './compute.ts';

// A module that imports one page and grows by one page per call, as Rust's
// allocator does on its first allocation. The output is a single status byte.
const moduleBytes = Uint8Array.from(
  Buffer.from(
    [
      '0061736d01000000',
      '010f0360017f017f60027f7f006000017e', // alloc, dealloc, grow signatures
      '020f0103656e76066d656d6f7279020001', // import env.memory (min 1)
      '030403000102',
      '071a0305616c6c6f630000076465616c6c6f6300010467726f770002',
      '0a1903040041000b02000b0f0041014000417f460440000b42010b',
    ].join(''),
    'hex',
  ),
);

it('lets the allocator acquire pages up to its grant', () => {
  const call = loadComputeModule(moduleBytes, 2 * 65536);
  expect(call('grow', []).byteLength).toBe(0);
  expect(() => call('grow', [])).toThrow(/unreachable/);
});
