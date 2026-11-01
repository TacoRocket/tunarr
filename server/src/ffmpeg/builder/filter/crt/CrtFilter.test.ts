import { ChannelCrtSettingsSchema } from '@tunarr/types/schemas';
import { ColorSpaces } from '../../constants.ts';
import { FrameState } from '../../state/FrameState.ts';
import { FrameSize } from '../../types.ts';
import { CrtFilter } from './CrtFilter.ts';

test('Quality supplies the output matrix required for untagged SDR video', () => {
  const filter = new CrtFilter(
    { enabled: true, look: 'subtle', processing: 'quality' },
    FrameSize.FHD,
  );
  expect(filter.filter).toContain('format=nv12:colorspace=bt709:');
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
test.each([undefined, 'quality', 'performance', 'experimental'] as const)(
  'API/default composite grain requires explicit Experimental processing (%s)',
  (processing) => {
    for (const broadcastGrain of ['half', true] as const) {
      const settings = ChannelCrtSettingsSchema.parse({
        enabled: true,
        look: 'dvd-broadcast',
        processing,
        broadcastComposite: true,
        broadcastGrain,
      });
      const graph = new CrtFilter(settings, FrameSize.FHD, false, true).filter;
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

// The old native path selected point sampling and paired reads without a tier opt-in.
test.each([undefined, 'quality', 'performance', 'experimental'] as const)(
  'stored processing gates all three optimizations even with runtime flags (%s)',
  (processing) => {
    vi.stubEnv('TUNARR_CRT_DIRECT_NV12', '1');
    vi.stubEnv('ETV_VAAPI_DIRECT_NV12', '1');
    vi.stubEnv('TUNARR_CRT_NV12_OUTPUT', 'native');
    vi.stubEnv('TUNARR_VAAPI_DEFAULT_SCALING', '1');
    try {
      const settings = ChannelCrtSettingsSchema.parse({
        enabled: true,
        look: 'dvd-broadcast',
        processing,
        broadcastComposite: true,
        broadcastGrain: 'half',
      });
      if (processing === undefined)
        Reflect.deleteProperty(settings, 'processing');
      const graph = new CrtFilter(settings, FrameSize.FHD, false, true).filter;
      const shader = shaderFrom(graph);
      const experimental = processing === 'experimental';
      expect(graph.includes('plane_downscaler_kernel=box')).toBe(experimental);
      expect(graph.includes('plane_downscaler=mitchell')).toBe(!experimental);
      expect(shader.includes('if (HOOKED_size.x ==')).toBe(experimental);
      expect(shader.includes('//!DESC SD monochrome grain')).toBe(
        !experimental,
      );
      expect(graph.includes('nv12_output=native')).toBe(
        processing === 'performance' || experimental,
      );
      expect(graph.includes(':mode=default')).toBe(
        processing === 'performance' || experimental,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test('omitted processing selects Quality at the schema boundary', () => {
  expect(ChannelCrtSettingsSchema.parse({ enabled: true }).processing).toBe(
    'quality',
  );
});

test.each([
  [1280, 720, 'performance'],
  [1280, 720, 'experimental'],
  [1440, 1080, 'performance'],
  [1440, 1080, 'experimental'],
  [3840, 2160, 'performance'],
  [3840, 2160, 'experimental'],
] as const)(
  '%ix%i %s uses native output with the selected tier sampling',
  (width, height, processing) => {
    vi.stubEnv('TUNARR_CRT_DIRECT_NV12', '1');
    vi.stubEnv('ETV_VAAPI_DIRECT_NV12', '1');
    vi.stubEnv('TUNARR_CRT_NV12_OUTPUT', 'native');
    try {
      const size = FrameSize.withDimensions(width, height);
      const settings = ChannelCrtSettingsSchema.parse({
        enabled: true,
        look: 'dvd-broadcast',
        processing,
      });
      const graph = new CrtFilter(settings, size, false, true).filter;
      expect(graph).not.toContain('scale_vulkan=');
      expect(graph).toContain('nv12_output=native');
      expect(graph.includes('plane_downscaler_kernel=box')).toBe(
        processing === 'experimental',
      );
      expect(graph.includes('plane_downscaler=mitchell')).toBe(
        processing === 'performance',
      );
      expect(graph).toContain(`libplacebo=w=${width}:h=${height}`);
      const unavailable = new CrtFilter(settings, size, false, false).filter;
      expect(unavailable).not.toContain('nv12_output=native');
      expect(unavailable).toContain('scale_vulkan=format=nv12');
      expect(CrtFilter.usesDirectNv12Handoff(settings, size, true)).toBe(true);

      const quality = new CrtFilter(
        { ...settings, processing: 'quality' },
        size,
      );
      expect(quality.filter).toContain('scale_vulkan=format=nv12');
      vi.stubEnv('TUNARR_CRT_DIRECT_NV12', '0');
      expect(new CrtFilter(settings, size, false, true).filter).toContain(
        'scale_vulkan=format=nv12',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

function shaderFrom(graph: string): string {
  const hex = graph.match(/custom_shader_bin=([a-f0-9]+)/)?.[1];
  if (hex === undefined) throw new Error('Missing CRT shader');
  return Buffer.from(hex, 'hex').toString();
}
