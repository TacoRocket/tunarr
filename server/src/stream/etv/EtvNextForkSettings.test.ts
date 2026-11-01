import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.js';
import {
  crtShader,
  crtWorkerStage,
} from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { FrameSize } from '../../ffmpeg/builder/types.ts';
import { findIgnoredSettings } from './EtvNextChannelConfigMapper.ts';
import {
  applyForkChannelSettings,
  forkVaapiLowPower,
} from './EtvNextForkSettings.ts';
import type { ChannelConfig } from './generated/channelConfig.ts';

const workerConfig = (accel?: 'vaapi' | 'qsv', height = 1080) =>
  ({
    normalization: { video: { accel, width: (height * 16) / 9, height } },
  }) as unknown as ChannelConfig;

// the runtime flags of a server with the patched native-NV12 FFmpeg
const stubNativeRuntime = () => {
  vi.stubEnv('TUNARR_CRT_DIRECT_NV12', '1');
  vi.stubEnv('ETV_VAAPI_DIRECT_NV12', '1');
  vi.stubEnv('TUNARR_CRT_NV12_OUTPUT', 'native');
  vi.stubEnv('TUNARR_VAAPI_HABLE_LUT', '1');
};

const fields = (ignored: { field: string }[]) => ignored.map((s) => s.field);

describe('fork-only settings on the ErsatzTV next backend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('credit squeeze is handled per item, not dropped from the channel', () => {
    const config = workerConfig('vaapi');
    const ignored = applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'dvd-broadcast', processing: 'quality' },
      creditSqueeze: { enabled: true } as never,
    });

    expect(fields(ignored)).toEqual([]);
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
    expect(config.normalization.video.custom_shader_options).toBeUndefined();
    expect(config.normalization.video.vaapi_low_power).toBeUndefined();
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
    expect(
      crtWorkerStage({ ...crt, look: 'tv-broadcast' }, FrameSize.FHD)
        .inputHeight,
    ).toBe(360);
  });

  test.each([720, 1080, 2160])(
    'a faster tier sends its shader and runtime options at %ip',
    (height) => {
      stubNativeRuntime();
      const crt = {
        enabled: true,
        look: 'dvd-broadcast',
        processing: 'experimental',
        broadcastGrain: 'half',
        broadcastComposite: true,
        broadcastTexture: 'classic-flat',
      } as const;
      const config = workerConfig('vaapi', height);
      const frame = FrameSize.withDimensions((height * 16) / 9, height);
      const ignored = applyForkChannelSettings(config, {
        crt,
        creditSqueeze: null,
      });
      const video = config.normalization.video;

      expect(video.custom_shader).toBe(crtShader(crt, frame));
      expect(video.custom_shader).not.toBe(
        crtShader({ ...crt, processing: 'quality' }, frame),
      );
      expect(video.custom_shader_input_height).toBe(480);
      expect(video.custom_shader_options).toEqual({
        input_scale_mode: 'default',
        native_nv12_output: true,
        direct_nv12_handoff: true,
        point_chroma: true,
        hdr_vaapi_lut: true,
      });
      expect(video.vaapi_low_power).toBe('always');
      expect(ignored).toEqual([]);
    },
  );

  test('the worker follows a 720p channel with the native runtime and falls back without it', () => {
    const crt = {
      enabled: true,
      look: 'tv-broadcast',
      processing: 'performance',
    } as const;
    const plain = workerConfig('vaapi');
    applyForkChannelSettings(plain, { crt, creditSqueeze: null });
    expect(plain.normalization.video.custom_shader_options).toEqual({
      input_scale_mode: 'default',
    });
    expect(plain.normalization.video.vaapi_low_power).toBe('always');

    stubNativeRuntime();
    const hd = workerConfig('vaapi', 720);
    applyForkChannelSettings(hd, { crt, creditSqueeze: null });
    expect(hd.normalization.video.custom_shader_options).toEqual({
      input_scale_mode: 'default',
      native_nv12_output: true,
      direct_nv12_handoff: true,
    });
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

describe('HLS Direct v2 keeps direct play on the ErsatzTV next backend', () => {
  const withAudio = (loudnorm = false) => {
    const config = workerConfig('vaapi');
    (config.normalization as { audio: unknown }).audio = {
      format: 'aac',
      ...(loudnorm ? { normalize_loudness: true } : {}),
    };
    return config;
  };

  test('copies video and audio, leaving the worker to transcode items it cannot copy', () => {
    const config = withAudio();
    const ignored = applyForkChannelSettings(config, {
      crt: null,
      creditSqueeze: null,
      streamMode: 'hls_direct_v2',
    });

    expect(config.normalization.video.mode).toBe('copy');
    expect(config.normalization.audio.mode).toBe('copy');
    expect(ignored).toEqual([]);
  });

  test('other stream modes keep transcoding every item', () => {
    for (const streamMode of ['hls', 'mpegts'] as const) {
      const config = withAudio();
      applyForkChannelSettings(config, {
        crt: null,
        creditSqueeze: null,
        streamMode,
      });

      expect(config.normalization.video.mode).toBeUndefined();
      expect(config.normalization.audio.mode).toBeUndefined();
    }
  });

  test('a CRT look keeps the video transcoding so it is still drawn', () => {
    const config = withAudio();
    applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
      creditSqueeze: null,
      streamMode: 'hls_direct_v2',
    });

    expect(config.normalization.video.custom_shader).toBeDefined();
    expect(config.normalization.video.mode).toBeUndefined();
    expect(config.normalization.audio.mode).toBe('copy');
  });

  test('a CRT look the worker cannot draw does not stop the copy', () => {
    const config = workerConfig('qsv');
    applyForkChannelSettings(config, {
      crt: { enabled: true, look: 'classic-flat', processing: 'quality' },
      creditSqueeze: null,
      streamMode: 'hls_direct_v2',
    });

    expect(config.normalization.video.custom_shader).toBeUndefined();
    expect(config.normalization.video.mode).toBe('copy');
  });

  test('loudness normalization keeps the audio transcoding', () => {
    const config = withAudio(true);
    applyForkChannelSettings(config, {
      crt: null,
      creditSqueeze: null,
      streamMode: 'hls_direct_v2',
    });

    expect(config.normalization.video.mode).toBe('copy');
    expect(config.normalization.audio.mode).toBeUndefined();
  });
});
