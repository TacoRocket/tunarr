import type { ChannelStreamMode } from '@tunarr/types';
import { describe, expect, test } from 'vitest';
import { routesToEtvNext } from './EtvNextRouting.ts';

describe('routesToEtvNext', () => {
  const allModes: ChannelStreamMode[] = [
    'hls',
    'hls_slower',
    'mpegts',
    'hls_direct',
    'hls_direct_v2',
  ];

  const routableModes: ChannelStreamMode[] = ['hls', 'hls_direct_v2', 'mpegts'];

  // Both of these are on their way out, and hls_direct remuxes without
  // transcoding, which the worker cannot do.
  const unroutableModes: ChannelStreamMode[] = ['hls_direct', 'hls_slower'];

  test.each(allModes)(
    'leaves %s alone when the channel has not opted in',
    (mode) => {
      expect(routesToEtvNext(mode, false)).toBe(false);
    },
  );

  test.each(routableModes)('routes %s when the channel opts in', (mode) => {
    expect(routesToEtvNext(mode, true)).toBe(true);
  });

  // A channel cannot opt into a mode the worker has no way to serve.
  test.each(unroutableModes)(
    'keeps %s on Tunarr even when the channel opts in',
    (mode) => {
      expect(routesToEtvNext(mode, true)).toBe(false);
    },
  );
});
