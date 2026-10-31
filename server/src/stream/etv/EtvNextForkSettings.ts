import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import type { IgnoredSetting } from './EtvNextChannelConfigMapper.ts';

// Fork-only picture settings run inside Tunarr's own FFmpeg pipeline. The
// ErsatzTV next worker builds its own pipeline and reads none of them, so a
// channel moved to that backend plays without them. They are listed beside
// upstream's dropped settings, so the session log, the troubleshooter and the
// transcode config check say so instead of the look silently disappearing.

export function findForkOnlyTranscodeSettings(
  transcodeConfig: Pick<TranscodeConfigOrm, 'vaapiLowPower'>,
): IgnoredSetting[] {
  return transcodeConfig.vaapiLowPower
    ? [
        {
          field: 'vaapiLowPower',
          reason: 'the backend has no VAAPI low-power encoding switch',
        },
      ]
    : [];
}

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
