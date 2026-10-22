import { ColorSpaces } from '../../constants.ts';
import { FrameState } from '../../state/FrameState.ts';
import { FrameSize } from '../../types.ts';
import { CrtFilter } from './CrtFilter.ts';

test('Performance supplies the output matrix required for untagged SDR video', () => {
  const filter = new CrtFilter(
    { enabled: true, look: 'subtle', processing: 'performance' },
    FrameSize.FHD,
  );
  expect(filter.filter).toContain('format=rgba:colorspace=bt709:');
  const state = new FrameState({
    scaledSize: FrameSize.FHD,
    paddedSize: FrameSize.FHD,
    isAnamorphic: false,
  });
  expect(filter.nextState(state).colorFormat?.colorSpace).toBe(ColorSpaces.Bt709);
});
