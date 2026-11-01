import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import { crtLookShader } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
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

type WorkerCrtLook = Parameters<typeof crtLookShader>[0];

const isWorkerCrtLook = (
  look: ChannelCrtSettings['look'],
): look is WorkerCrtLook =>
  look === 'subtle' || look === 'classic-flat' || look === 'strong';

// The fork's worker build draws the CRT looks other than the broadcast ones:
// Tunarr hands it the look's shader (`custom_shader`), and on VAAPI it runs the
// shader while scaling, as Tunarr's own Quality path does. HDR programs play
// without the look on both backends.
export function applyForkChannelSettings(
  config: ChannelConfig,
  channel: Pick<ChannelOrm, 'crt'>,
): void {
  const crt = channel.crt;
  if (
    crt?.enabled &&
    isWorkerCrtLook(crt.look) &&
    config.normalization.video.accel === 'vaapi'
  ) {
    config.normalization.video.custom_shader = crtLookShader(crt.look);
  }
}

// The rest of the fork-only picture settings run inside Tunarr's own FFmpeg
// pipeline. The ErsatzTV next worker builds its own pipeline and reads none of
// them, so a channel moved to that backend plays without them. They are listed
// beside upstream's dropped settings, so the session log and the troubleshooter
// say so instead of the look silently disappearing.

export function findForkOnlyChannelSettings(
  channel: Pick<ChannelOrm, 'crt' | 'creditSqueeze'>,
): IgnoredSetting[] {
  const ignored: IgnoredSetting[] = [];
  if (channel.crt?.enabled) {
    if (!isWorkerCrtLook(channel.crt.look)) {
      ignored.push({
        field: 'crt',
        reason: "the broadcast looks are drawn by Tunarr's own pipeline only",
      });
    } else if (usesCrtHardwareProcessing(channel.crt)) {
      ignored.push({
        field: 'crt.processing',
        reason:
          'the backend draws the look as Quality does; low-power encoding follows the transcode profile',
      });
    }
  }
  if (channel.creditSqueeze?.enabled) {
    ignored.push({
      field: 'creditSqueeze',
      reason: "credit squeeze is drawn by Tunarr's own pipeline only",
    });
  }
  return ignored;
}
