import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import { crtWorkerStage } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { usesCrtHardwareProcessing } from '../../ffmpeg/builder/filter/crt/processingTier.ts';
import type { IgnoredSetting } from './EtvNextChannelConfigMapper.ts';
import type {
  ChannelConfig,
  CustomShaderOptionsConfig,
  HardwareAccel,
  VideoNormalizationConfig,
} from './generated/channelConfig.ts';
import { FrameSize } from '../../ffmpeg/builder/types.ts';

// `vaapiLowPower` asks for low-power (VDEnc) H.264 encoding. The fork's worker
// build takes that as `always`. Left off, the field is omitted and the worker
// keeps its own default, which uses low power for HEVC only.
export function forkVaapiLowPower(
  transcodeConfig: Pick<TranscodeConfigOrm, 'vaapiLowPower'>,
  accel: HardwareAccel | undefined,
): Pick<VideoNormalizationConfig, 'vaapi_low_power'> {
  return accel === 'vaapi' && transcodeConfig.vaapiLowPower
    ? { vaapi_low_power: 'always' }
    : {};
}

// Fork-only channel settings on the ErsatzTV next worker. The fork's worker
// build draws the CRT looks: Tunarr hands it the shader its own pipeline draws
// for the channel's tier (`custom_shader`), the 480 or 360 lines a broadcast
// look first scales the picture to (`custom_shader_input_height`), and the
// faster tiers' options (`custom_shader_options`), decided as its own pipeline
// decides them. On VAAPI the worker runs the shader while scaling. The faster
// tiers request low-power encoding, as they do in Tunarr's own pipeline. HDR
// programs play without the look unless DVD Broadcast takes the fixed-Hable
// path.
//
// What the worker cannot draw is returned, to be listed beside upstream's
// dropped settings, so the session log and the troubleshooter say so instead
// of the look silently disappearing. Drawing and reporting share one check so
// they cannot disagree.
//
// An HLS Direct v2 channel keeps direct play: see `forkDirectCopy`.
export function applyForkChannelSettings(
  config: ChannelConfig,
  channel: Pick<ChannelOrm, 'crt' | 'creditSqueeze'> &
    Partial<Pick<ChannelOrm, 'streamMode'>>,
): IgnoredSetting[] {
  const ignored: IgnoredSetting[] = [];
  const crt = channel.crt;
  if (crt?.enabled) {
    if (config.normalization.video.accel !== 'vaapi') {
      ignored.push({
        field: 'crt',
        reason: 'the backend draws the CRT look only with VAAPI',
      });
    } else {
      const video = config.normalization.video;
      const stage = crtWorkerStage(
        crt,
        FrameSize.withDimensions(video.width ?? 1920, video.height ?? 1080),
      );
      video.custom_shader = stage.shader;
      if (stage.inputHeight !== undefined) {
        video.custom_shader_input_height = stage.inputHeight;
      }
      const options: CustomShaderOptionsConfig = {
        ...(stage.inputScaleMode
          ? { input_scale_mode: stage.inputScaleMode }
          : {}),
        ...(stage.nativeNv12Output ? { native_nv12_output: true } : {}),
        ...(stage.directNv12Handoff ? { direct_nv12_handoff: true } : {}),
        ...(stage.pointChroma ? { point_chroma: true } : {}),
        ...(stage.hdrVaapiLut ? { hdr_vaapi_lut: true } : {}),
      };
      if (Object.keys(options).length > 0) {
        video.custom_shader_options = options;
      }
      if (usesCrtHardwareProcessing(crt)) {
        video.vaapi_low_power = 'always';
      }
    }
  }
  if (channel.streamMode === 'hls_direct_v2') {
    forkDirectCopy(config);
  }
  return ignored;
}

// HLS Direct v2 passes the source video through in Tunarr's own pipeline. The
// worker can do the same per item (`mode: copy`): it copies an item whose codec
// it allows and transcodes one it can't copy, such as an item with a watermark,
// burned-in or image subtitles, a still image, or a file that doesn't begin on a
// keyframe. Joining mid-item still copies, from the keyframe at or before the
// join point. Its copy check doesn't know about a custom shader, so a CRT
// channel keeps transcoding to keep its look. Audio is copied too, unless the
// profile normalizes loudness, which the worker can only do while transcoding.
function forkDirectCopy(config: ChannelConfig) {
  const { video, audio } = config.normalization;
  if (video.custom_shader === undefined) {
    video.mode = 'copy';
  }
  if (audio && !audio.normalize_loudness) {
    audio.mode = 'copy';
  }
}
