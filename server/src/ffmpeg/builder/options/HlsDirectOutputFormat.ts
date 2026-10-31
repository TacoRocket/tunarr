import { OutputOption } from './OutputOption.ts';

/**
 * A WebVTT subtitle written by the HLS muxer itself. It cuts the subtitle at
 * the same keyframes as the video, so stream<N>.vtt covers data<N>.ts on the
 * same clock, and it writes an empty file for a segment without cues.
 */
type HlsMuxedSubtitle = {
  mapRef: string;
  playlistPath: string;
  // Whether the input is read at playback speed, with no initial burst.
  realtime: boolean;
  // Drop cues that start before this source time, in seconds.
  dropCuesBeforeSeconds?: number;
};

/**
 * HLS output format for direct stream copy mode (no transcoding).
 * Unlike HlsOutputFormat, this does NOT include keyframe-forcing options
 * (-g, -keyint_min, -force_key_frames) which are incompatible with -c:v copy.
 * Segments will be created at source keyframe boundaries.
 */
export class HlsDirectOutputFormat extends OutputOption {
  public static SegmentSeconds = 4;

  constructor(
    private playlistPath: string,
    private segmentTemplate: string,
    private baseStreamUrl: string,
    private isFirstTranscode: boolean,
    private emitEndList: boolean = false,
    private subtitle?: HlsMuxedSubtitle,
  ) {
    super();
  }

  options(): string[] {
    const opts = [
      '-f',
      'hls',
      '-hls_time',
      `${HlsDirectOutputFormat.SegmentSeconds}`,
      '-hls_list_size',
      '0',
      '-segment_list_flags',
      '+live',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      this.segmentTemplate,
      '-hls_base_url',
      this.baseStreamUrl,
      '-copyts', // Preserve original timestamps
      '-master_pl_name',
      'playlist.m3u8',
    ];

    const flags = ['program_date_time', 'append_list', 'independent_segments'];
    if (!this.emitEndList) flags.push('omit_endlist');
    if (!this.isFirstTranscode) flags.push('discont_start');

    opts.push('-hls_flags', flags.join('+'));

    if (!this.isFirstTranscode) {
      // HLS owns the MPEG-TS muxer; outer muxer options do not reach it.
      opts.push('-hls_segment_options', 'mpegts_flags=+initial_discontinuity');
    }

    if (this.subtitle) {
      opts.push(
        '-map',
        this.subtitle.mapRef,
        '-c:s',
        'webvtt',
        '-hls_subtitle_path',
        this.subtitle.playlistPath,
      );
      if (this.subtitle.dropCuesBeforeSeconds !== undefined) {
        // The muxer must see a video packet first. A cue still showing at the
        // start began before it, so it is dropped with the earlier ones.
        opts.push(
          '-bsf:s',
          `noise=drop=lt(pts*tb\\,${this.subtitle.dropCuesBeforeSeconds})`,
        );
      }
      // Muxing waits for a packet from every stream, by default for up to 10
      // seconds of media. Cues are sparse, so the video would reach the
      // playlist in bursts, up to 10 seconds late. The wait only has to cover
      // how far subtitle conversion trails the copied video. Read at playback
      // speed that is milliseconds. During a read burst, milliseconds are
      // seconds of media, so keep the default there; the burst runs ahead.
      if (this.subtitle.realtime) {
        opts.push('-max_interleave_delta', '2000000');
      }
    }

    opts.push(this.playlistPath);

    return opts;
  }
}
