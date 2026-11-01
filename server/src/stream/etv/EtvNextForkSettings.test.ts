import { describe, expect, test } from 'vitest';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import { findIgnoredSettings } from './EtvNextChannelConfigMapper.ts';
import {
  findForkOnlyChannelSettings,
  forkVaapiLowPower,
} from './EtvNextForkSettings.ts';

describe('fork-only settings on the ErsatzTV next backend', () => {
  test('a channel with a CRT look or credit squeeze is told they will not apply', () => {
    const fields = findForkOnlyChannelSettings({
      crt: { enabled: true, look: 'subtle', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    }).map((s) => s.field);

    expect(fields).toEqual(['crt', 'creditSqueeze']);
  });

  test('settings that are off, or never set, are not listed', () => {
    expect(
      findForkOnlyChannelSettings({
        crt: { enabled: false, look: 'subtle', processing: 'quality' },
        creditSqueeze: null,
      }),
    ).toEqual([]);
  });

  test('VAAPI low power reaches the worker as `always` and is not reported as dropped', () => {
    expect(forkVaapiLowPower({ vaapiLowPower: true }, 'vaapi')).toEqual({
      vaapi_low_power: 'always',
    });
    const fields = findIgnoredSettings({
      threadCount: 0,
      audioVolumePercent: 100,
      hardwareAccelerationMode: 'vaapi',
      vaapiDriver: 'system',
      vaapiLowPower: true,
    } as TranscodeConfigOrm).map((s) => s.field);
    expect(fields).not.toContain('vaapiLowPower');
  });

  test('low power off, or not VAAPI, leaves the worker its own default', () => {
    expect(forkVaapiLowPower({ vaapiLowPower: false }, 'vaapi')).toEqual({});
    expect(forkVaapiLowPower({ vaapiLowPower: true }, 'qsv')).toEqual({});
    expect(forkVaapiLowPower({ vaapiLowPower: true }, undefined)).toEqual({});
  });
});
