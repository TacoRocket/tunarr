import { describe, expect, test } from 'vitest';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import { crtLookShader } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { findIgnoredSettings } from './EtvNextChannelConfigMapper.ts';
import {
  applyForkChannelSettings,
  forkVaapiLowPower,
} from './EtvNextForkSettings.ts';
import type { ChannelConfig } from './generated/channelConfig.ts';

const workerConfig = (accel?: 'vaapi' | 'qsv') =>
  ({ normalization: { video: { accel } } }) as unknown as ChannelConfig;

const fields = (ignored: { field: string }[]) => ignored.map((s) => s.field);

describe('fork-only settings on the ErsatzTV next backend', () => {
  test('a broadcast CRT look or credit squeeze is told it will not apply', () => {
    const config = workerConfig('vaapi');
    const ignored = applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'dvd-broadcast', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    });

    expect(fields(ignored)).toEqual(['crt', 'creditSqueeze']);
    expect(config.normalization.video.custom_shader).toBeUndefined();
  });

  test('the other CRT looks reach the worker as their shader on VAAPI', () => {
    const config = workerConfig('vaapi');
    const ignored = applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
      creditSqueeze: null,
    });

    expect(config.normalization.video.custom_shader).toBe(
      crtLookShader('classic-flat'),
    );
    expect(config.normalization.video.custom_shader).toContain('//!HOOK');
    expect(ignored).toEqual([]);
  });

  // A shared profile can be switched off VAAPI after the channel's CRT look
  // was saved; the look must not disappear unreported.
  test('without VAAPI the look is reported as not drawn, whatever the tier', () => {
    for (const processing of ['quality', 'experimental'] as const) {
      const config = workerConfig('qsv');
      const ignored = applyForkChannelSettings(config, {
        crt: { enabled: true, look: 'classic-flat', processing },
        creditSqueeze: null,
      });

      expect(config.normalization.video.custom_shader).toBeUndefined();
      expect(ignored).toEqual([
        {
          field: 'crt',
          reason: 'the backend draws the CRT look only with VAAPI',
        },
      ]);
    }
  });

  test('a faster processing tier is reported, since the backend draws the look as Quality does', () => {
    const ignored = applyForkChannelSettings(workerConfig('vaapi'), {
      crt: { enabled: true, look: 'strong', processing: 'performance' },
      creditSqueeze: null,
    });

    expect(fields(ignored)).toEqual(['crt.processing']);
  });

  test('settings that are off, or never set, are neither drawn nor listed', () => {
    const config = workerConfig('vaapi');
    expect(
      applyForkChannelSettings(config, {
        crt: { enabled: false, look: 'subtle', processing: 'quality' },
        creditSqueeze: null,
      }),
    ).toEqual([]);
    expect(config.normalization.video.custom_shader).toBeUndefined();
    expect(
      applyForkChannelSettings(workerConfig('qsv'), {
        crt: null,
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
