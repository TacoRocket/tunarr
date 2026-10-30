import { ChannelCrtSettingsSchema } from '@tunarr/types/schemas';
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
  expect(filter.nextState(state).colorFormat?.colorSpace).toBe(
    ColorSpaces.Bt709,
  );
});

// PR75 previously fused every composite+grain channel without an opt-in.
test.each([undefined, 'standard', 'performance', 'experimental'] as const)(
  'composite grain requires explicit Experimental processing (%s)',
  (processing) => {
    for (const broadcastGrain of ['half', true] as const) {
      const settings = ChannelCrtSettingsSchema.parse({
        enabled: true,
        look: 'dvd-broadcast',
        processing,
        broadcastComposite: true,
        broadcastGrain,
      });
      const graph = new CrtFilter(settings, FrameSize.FHD).filter;
      const shaderHex = graph.match(/custom_shader_bin=([a-f0-9]+)/)?.[1];
      expect(shaderHex).toBeDefined();
      if (shaderHex === undefined) throw new Error('Missing CRT shader');
      const shader = Buffer.from(shaderHex, 'hex').toString();
      const experimental = processing === 'experimental';
      expect(shader.includes('//!DESC SD monochrome grain')).toBe(
        !experimental,
      );
      expect(shader.match(/^\/\/!HOOK /gm)).toHaveLength(experimental ? 5 : 6);
      expect(shader).toContain(
        experimental
          ? 'return apply_broadcast_grain(vec4(clamp(rgb'
          : 'return vec4(clamp(rgb',
      );
    }
  },
);
