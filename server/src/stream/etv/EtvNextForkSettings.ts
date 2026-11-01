import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import { crtQualityShader } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { usesCrtHardwareProcessing } from '../../ffmpeg/builder/filter/crt/processingTier.ts';
import type { IgnoredSetting } from './EtvNextChannelConfigMapper.ts';
import type {
  ChannelConfig,
  HardwareAccel,
  VideoNormalizationConfig,
} from './generated/channelConfig.ts';

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

// The fork's worker build draws the CRT looks: Tunarr hands it the shader its
// own Quality path draws (`custom_shader`), plus the 480 or 360 lines a
// broadcast look first scales the picture to (`custom_shader_input_height`).
// On VAAPI the worker runs the shader while scaling, as Quality does. HDR
// programs play without the look on both backends.
export function applyForkChannelSettings(
  config: ChannelConfig,
  channel: Pick<ChannelOrm, 'crt'>,
): void {
  const crt = channel.crt;
  if (crt?.enabled && config.normalization.video.accel === 'vaapi') {
    const { shader, inputHeight } = crtQualityShader(crt);
    config.normalization.video.custom_shader = shader;
    if (inputHeight !== undefined) {
      config.normalization.video.custom_shader_input_height = inputHeight;
    }
  }
}

// The other fork-only picture settings run inside Tunarr's own FFmpeg
// pipeline. The ErsatzTV next worker builds its own pipeline and reads none of
// them, so a channel moved to that backend plays without them. They are listed
// beside upstream's dropped settings, so the session log and the troubleshooter
// say so instead of the look silently disappearing.

export function findForkOnlyChannelSettings(
  channel: Pick<ChannelOrm, 'crt' | 'creditSqueeze'>,
): IgnoredSetting[] {
  const ignored: IgnoredSetting[] = [];
  // The worker draws every look as Quality does, so a faster tier's shortcuts
  // and its low-power request do not apply.
  if (channel.crt?.enabled && usesCrtHardwareProcessing(channel.crt)) {
    ignored.push({
      field: 'crt.processing',
      reason:
        'the backend draws the look as Quality does; low-power encoding follows the transcode profile',
    });
  }
  if (channel.creditSqueeze?.enabled) {
    ignored.push({
      field: 'creditSqueeze',
      reason: "credit squeeze is drawn by Tunarr's own pipeline only",
    });
  }
  return ignored;
}
