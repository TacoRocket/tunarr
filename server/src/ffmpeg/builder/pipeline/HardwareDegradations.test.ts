import { describe, expect, test, vi } from 'vitest';
import { HardwareAccelerationMode } from '@/db/schema/TranscodeConfig.js';
import { FileStreamSource } from '@/stream/types.js';
import { BaseFfmpegHardwareCapabilities } from '../capabilities/BaseFfmpegHardwareCapabilities.ts';
import { EmptyFfmpegCapabilities } from '../capabilities/FfmpegCapabilities.ts';
import { VideoFormats } from '../constants.ts';
import { PixelFormatYuv420P } from '../format/PixelFormat.ts';
import { VideoInputSource } from '../input/VideoInputSource.ts';
import { VideoStream } from '../MediaStream.ts';
import { DefaultPipelineOptions, FfmpegState } from '../state/FfmpegState.ts';
import { FrameState } from '../state/FrameState.ts';
import { FrameSize } from '../types.ts';
import { QsvPipelineBuilder } from './hardware/QsvPipelineBuilder.ts';
import { VaapiPipelineBuilder } from './hardware/VaapiPipelineBuilder.ts';
import { VideoToolboxPipelineBuilder } from './hardware/VideoToolboxPipelineBuilder.ts';
import { NvidiaPipelineBuilder } from './nvidia/NvidiaPipelineBuilder.ts';

class Capabilities extends BaseFfmpegHardwareCapabilities {
  readonly type = 'test';
  canDecode = vi.fn(() => true);
  canEncode = vi.fn(() => true);
}

const version = {
  versionString: '8.1.2',
  majorVersion: 8,
  minorVersion: 1,
  patchVersion: 2,
  isUnknown: false,
};

// Exercise the existing capability-to-CPU branches through their real builders.
describe.each([
  ['VAAPI', VaapiPipelineBuilder],
  ['QSV', QsvPipelineBuilder],
  ['NVIDIA', NvidiaPipelineBuilder],
  ['VideoToolbox', VideoToolboxPipelineBuilder],
] as const)('%s degradation reporting', (_, Builder) => {
  function build(
    opts: {
      decode?: boolean;
      encode?: boolean;
      disabled?: boolean;
      intermediate?: boolean;
      copy?: boolean;
    } = {},
  ) {
    const capabilities = new Capabilities();
    capabilities.canDecode.mockReturnValue(opts.decode ?? true);
    capabilities.canEncode.mockReturnValue(opts.encode ?? true);
    const video = VideoInputSource.withStream(
      new FileStreamSource('/media/item.mkv'),
      VideoStream.create({
        index: 0,
        codec: VideoFormats.H264,
        profile: 'main',
        colorFormat: null,
        frameSize: FrameSize.FHD,
        displayAspectRatio: '16:9',
        providedSampleAspectRatio: '1:1',
        pixelFormat: new PixelFormatYuv420P(),
      }),
    );
    const state = FfmpegState.create({
      version,
      outputFormat: { type: opts.intermediate ? 'nut' : 'mpegts' },
    });
    const desired = new FrameState({
      isAnamorphic: false,
      scaledSize: FrameSize.FHD,
      paddedSize: FrameSize.FHD,
      pixelFormat: new PixelFormatYuv420P(),
      videoFormat: opts.copy
        ? VideoFormats.Copy
        : opts.intermediate
          ? VideoFormats.Raw
          : VideoFormats.H264,
    });
    const pipeline = new Builder(
      capabilities,
      EmptyFfmpegCapabilities,
      video,
      null,
      null,
      null,
      null,
    ).build(state, desired, {
      ...DefaultPipelineOptions,
      disableHardwareDecoding: opts.disabled ?? false,
      disableHardwareEncoding: opts.disabled ?? false,
    });
    return { pipeline, state, capabilities };
  }

  test('reports unavailable decode once without changing the selected CPU mode', () => {
    const { pipeline, state, capabilities } = build({ decode: false });
    expect(state.decoderHwAccelMode).toBe(HardwareAccelerationMode.None);
    expect(pipeline.degradations.map((d) => d.code)).toEqual([
      'hardware_decode_unavailable',
    ]);
    expect(capabilities.canDecode).toHaveBeenCalledOnce();
  });

  test('reports unavailable encode once without changing the selected CPU mode', () => {
    const { pipeline, state, capabilities } = build({ encode: false });
    expect(state.encoderHwAccelMode).toBe(HardwareAccelerationMode.None);
    expect(pipeline.degradations.map((d) => d.code)).toEqual([
      'hardware_encode_unavailable',
    ]);
    expect(capabilities.canEncode).toHaveBeenCalledOnce();
  });

  test('does not report supported hardware or explicitly disabled hardware', () => {
    expect(build().pipeline.degradations).toEqual([]);
    const { pipeline, capabilities } = build({ disabled: true });
    expect(pipeline.degradations).toEqual([]);
    expect(capabilities.canDecode).not.toHaveBeenCalled();
    expect(capabilities.canEncode).not.toHaveBeenCalled();
  });

  test('does not call deliberate raw output or stream copy an encoding fallback', () => {
    expect(
      build({ intermediate: true, encode: false }).pipeline.degradations,
    ).toEqual([]);
    expect(
      build({ copy: true, encode: false, decode: false }).pipeline.degradations,
    ).toEqual([]);
  });
});
