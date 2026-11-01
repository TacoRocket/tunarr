import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import type { IgnoredSetting } from './EtvNextChannelConfigMapper.ts';
import type {
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

// Fork-only picture settings run inside Tunarr's own FFmpeg pipeline. The
// ErsatzTV next worker builds its own pipeline and reads none of them, so a
// channel moved to that backend plays without them. They are listed beside
// upstream's dropped settings, so the session log and the troubleshooter say
// so instead of the look silently disappearing.

export function findForkOnlyChannelSettings(
  channel: Pick<ChannelOrm, 'crt' | 'creditSqueeze'>,
): IgnoredSetting[] {
  const ignored: IgnoredSetting[] = [];
  if (channel.crt?.enabled) {
    ignored.push({
      field: 'crt',
      reason: "the CRT look is drawn by Tunarr's own pipeline only",
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
