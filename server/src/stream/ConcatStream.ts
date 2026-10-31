import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FFmpegAssistedFactory } from '@/ffmpeg/FFmpegModule.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { MpegTsOutputFormat } from '@/ffmpeg/builder/constants.js';
import { ConcatStreamModeToChildMode } from '@/ffmpeg/types.js';
import { makeFfmpegPlaylistUrl, makeLocalUrl } from '@/util/serverUtil.js';
import type { ChannelConcatStreamMode } from '@tunarr/types/schemas';

export type ConcatStreamFactory = (
  channel: ChannelOrmWithTranscodeConfig,
  streamMode: ChannelConcatStreamMode,
) => ConcatStream;
export class ConcatStream {
  constructor(
    private channel: ChannelOrmWithTranscodeConfig,
    private streamMode: ChannelConcatStreamMode,
    private ffmpegFactory: FFmpegAssistedFactory,
  ) {}

  async createSession(
    reportingSessionId?: string,
  ): Promise<FfmpegTranscodeSession> {
    const ffmpeg = this.ffmpegFactory(
      this.channel.transcodeConfig,
      this.channel,
    );

    const childStreamMode = ConcatStreamModeToChildMode[this.streamMode];

    const streamUrl =
      this.streamMode === 'mpegts_concat'
        ? makeFfmpegPlaylistUrl({
            channel: this.channel.uuid,
            audioOnly: false, // TODO
            mode: 'mpegts',
            reportingSessionId,
          })
        : makeLocalUrl(`/stream/channels/${this.channel.uuid}.m3u8`, {
            mode: childStreamMode,
            reportingSessionId:
              childStreamMode === 'hls_direct' ? reportingSessionId : undefined,
            // The master playlist can list renditions that point back at the
            // same variant, which makes ffmpeg read the muxed streams twice.
            variant: true,
          });

    return ffmpeg.createConcatSession(streamUrl, {
      outputFormat: MpegTsOutputFormat,
      mode: this.streamMode,
    });
  }
}
