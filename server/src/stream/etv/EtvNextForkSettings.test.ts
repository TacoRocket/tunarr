import { describe, expect, test } from 'vitest';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import { crtLookShader } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { findIgnoredSettings } from './EtvNextChannelConfigMapper.ts';
import {
  applyForkChannelSettings,
  findForkOnlyChannelSettings,
  forkVaapiLowPower,
} from './EtvNextForkSettings.ts';
import type { ChannelConfig } from './generated/channelConfig.ts';

const workerConfig = (accel?: 'vaapi' | 'qsv') =>
  ({ normalization: { video: { accel } } }) as unknown as ChannelConfig;

describe('fork-only settings on the ErsatzTV next backend', () => {
  test('a broadcast CRT look or credit squeeze is told it will not apply', () => {
    const fields = findForkOnlyChannelSettings({
      crt: { enabled: true, look: 'dvd-broadcast', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    }).map((s) => s.field);

    expect(fields).toEqual(['crt', 'creditSqueeze']);
  });

  test('the other CRT looks reach the worker as their shader on VAAPI', () => {
    const config = workerConfig('vaapi');
    applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
    });

    expect(config.normalization.video.custom_shader).toBe(
      crtLookShader('classic-flat'),
    );
    expect(config.normalization.video.custom_shader).toContain('//!HOOK');
    expect(
      findForkOnlyChannelSettings({
        crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
        creditSqueeze: null,
      }),
    ).toEqual([]);
  });

  test('no shader without VAAPI, for a broadcast look, or with CRT off', () => {
    for (const [accel, crt] of [
      ['qsv', { enabled: true, look: 'subtle', processing: 'quality' }],
      ['vaapi', { enabled: true, look: 'tv-broadcast', processing: 'quality' }],
      ['vaapi', { enabled: false, look: 'subtle', processing: 'quality' }],
    ] as const) {
      const config = workerConfig(accel);
      applyForkChannelSettings(config, { crt });
      expect(config.normalization.video.custom_shader).toBeUndefined();
    }
  });

  test('a faster processing tier is reported, since the backend draws the look as Quality does', () => {
    expect(
      findForkOnlyChannelSettings({
        crt: { enabled: true, look: 'strong', processing: 'performance' },
        creditSqueeze: null,
      }).map((s) => s.field),
    ).toEqual(['crt.processing']);
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
