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
  findForkOnlyChannelSettings,
  forkVaapiLowPower,
} from './EtvNextForkSettings.ts';
import type { ChannelConfig } from './generated/channelConfig.ts';

const workerConfig = (accel?: 'vaapi' | 'qsv') =>
  ({ normalization: { video: { accel } } }) as unknown as ChannelConfig;

describe('fork-only settings on the ErsatzTV next backend', () => {
  test('credit squeeze is told it will not apply; a Quality CRT look is not listed', () => {
    const fields = findForkOnlyChannelSettings({
      crt: { enabled: true, look: 'dvd-broadcast', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    }).map((s) => s.field);

    expect(fields).toEqual(['creditSqueeze']);
  });

  test('a CRT look reaches the worker as the shader Quality draws, on VAAPI', () => {
    const config = workerConfig('vaapi');
    applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
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
    applyForkChannelSettings(config, { crt });

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

  test('no shader without VAAPI or with CRT off', () => {
    for (const [accel, crt] of [
      ['qsv', { enabled: true, look: 'subtle', processing: 'quality' }],
      [
        'vaapi',
        { enabled: false, look: 'tv-broadcast', processing: 'quality' },
      ],
    ] as const) {
      const config = workerConfig(accel);
      applyForkChannelSettings(config, { crt });
      expect(config.normalization.video.custom_shader).toBeUndefined();
      expect(
        config.normalization.video.custom_shader_input_height,
      ).toBeUndefined();
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
