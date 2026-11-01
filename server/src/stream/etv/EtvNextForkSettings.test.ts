import { describe, expect, test } from 'vitest';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import {
  crtQualityShader,
  crtShader,
} from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { FrameSize } from '../../ffmpeg/builder/types.ts';
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
  test('credit squeeze is told it will not apply; a Quality CRT look is not listed', () => {
    const config = workerConfig('vaapi');
    const ignored = applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'dvd-broadcast', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    });

    expect(fields(ignored)).toEqual(['creditSqueeze']);
    expect(config.normalization.video.custom_shader).toBeDefined();
  });

  test('a CRT look reaches the worker as the shader Quality draws, on VAAPI', () => {
    const config = workerConfig('vaapi');
    const ignored = applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
      creditSqueeze: null,
    });

    expect(config.normalization.video.custom_shader).toBe(
      crtShader(
        { enabled: true, look: 'classic-flat', processing: 'quality' },
        FrameSize.FHD,
      ),
    );
    expect(config.normalization.video.custom_shader).toContain('//!HOOK');
    expect(
      config.normalization.video.custom_shader_input_height,
    ).toBeUndefined();
    expect(ignored).toEqual([]);
  });

  test('a broadcast look also sends the lines it first scales to, with its extras', () => {
    const crt = {
      enabled: true,
      look: 'dvd-broadcast',
      processing: 'quality',
      broadcastGrain: 'half',
      broadcastComposite: true,
      broadcastTexture: 'classic-flat',
    } as const;
    const config = workerConfig('vaapi');
    applyForkChannelSettings(config, { crt, creditSqueeze: null });

    expect(config.normalization.video.custom_shader).toBe(
      crtShader(crt, FrameSize.FHD),
    );
    expect(config.normalization.video.custom_shader_input_height).toBe(480);
    expect(crtQualityShader({ ...crt, look: 'tv-broadcast' }).inputHeight).toBe(
      360,
    );
  });

  test('a faster tier is drawn as Quality draws it', () => {
    const crt = {
      enabled: true,
      look: 'dvd-broadcast',
      processing: 'experimental',
      broadcastGrain: true,
      broadcastComposite: true,
    } as const;
    const { shader } = crtQualityShader(crt);

    expect(shader).toBe(
      crtShader({ ...crt, processing: 'quality' }, FrameSize.FHD),
    );
    expect(shader).not.toBe(crtShader(crt, FrameSize.FHD));
  });

  // A shared profile can be switched off VAAPI after the channel's CRT look
  // was saved; the look must not disappear unreported.
  test('without VAAPI the look is reported as not drawn, whatever the tier', () => {
    for (const processing of ['quality', 'experimental'] as const) {
      const config = workerConfig('qsv');
      const ignored = applyForkChannelSettings(config, {
        crt: { enabled: true, look: 'tv-broadcast', processing },
        creditSqueeze: null,
      });

      expect(config.normalization.video.custom_shader).toBeUndefined();
      expect(
        config.normalization.video.custom_shader_input_height,
      ).toBeUndefined();
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
        crt: { enabled: false, look: 'tv-broadcast', processing: 'quality' },
        creditSqueeze: null,
      }),
    ).toEqual([]);
    expect(config.normalization.video.custom_shader).toBeUndefined();
    expect(
      config.normalization.video.custom_shader_input_height,
    ).toBeUndefined();
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
