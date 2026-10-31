import { OutputOption } from './OutputOption.ts';

/**
 * HLS subtitle sidecar output using the FFmpeg `segment` muxer with webvtt format.
 * Regular HLS uses a separate subtitle output; the session aligns these cue
 * files with the video playlist. Direct HLS v2 instead shares the video muxer.
 */
export class HlsSubtitleOutputFormat extends OutputOption {
  public static SegmentSeconds = 4;

  constructor(
    private subtitlePlaylistPath: string,
    private segmentTemplate: string,
    private baseStreamUrl: string,
    private subtitleMapRef: string,
    // Offset in seconds to align subtitle cue timestamps with the video PTS
    // timeline across transcode boundaries. Must match the video -output_ts_offset.
    private ptsOffsetSeconds: number = 0,
    // Continues segment/file numbering from a prior ffmpeg process for this
    // session instead of restarting at 0, so a client mid-poll on the
    // previous subs.m3u8 doesn't get pointed at an overwritten filename.
    // Note this does not affect the muxer's #EXT-X-MEDIA-SEQUENCE header,
    // which ffmpeg always writes as 0 for a fresh process regardless --
    // the HTTP layer re-derives that from on-disk segment numbers instead.
    private segmentStartNumber: number = 0,
  ) {
    super();
  }

  options(): string[] {
    // Without this, the segment muxer shifts the earliest surviving cue
    // after a subtitle input seek back to timestamp 0 instead of to its
    // actual (seeked) position.
    // A cue crossing the seek point can still have negative PTS. The inner
    // WebVTT muxer shifts that whole first file despite the outer setting,
    // delaying the next cues. Omit the crossing cue, as Direct HLS v2 does.
    const opts: string[] = [
      '-avoid_negative_ts',
      'disabled',
      '-bsf:s',
      'noise=drop=lt(pts*tb\\,0)',
    ];

    // Apply the same PTS offset as the video output so subtitle cue timestamps
    // stay in sync with the MPEG-TS PTS clock across transcode boundaries.
    // This lets us use a constant X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000
    // when serving the segments.
    if (this.ptsOffsetSeconds > 0) {
      opts.push('-output_ts_offset', `${this.ptsOffsetSeconds}`);
    }

    if (this.segmentStartNumber > 0) {
      opts.push('-segment_start_number', `${this.segmentStartNumber}`);
    }

    opts.push(
      '-map',
      this.subtitleMapRef,
      '-c:s',
      'webvtt',
      '-f',
      'segment',
      '-segment_time',
      `${HlsSubtitleOutputFormat.SegmentSeconds}`,
      '-segment_list',
      this.subtitlePlaylistPath,
      '-segment_list_type',
      'hls',
      '-segment_list_flags',
      'live',
      // Keep a rolling window of 20 entries so that #EXT-X-MEDIA-SEQUENCE
      // advances as the stream progresses. Without this, the playlist always
      // shows #EXT-X-MEDIA-SEQUENCE:0 and clients that re-enable subtitles
      // try to fetch segments from the beginning, which may no longer exist.
      '-segment_list_size',
      '20',
      '-segment_format',
      'webvtt',
      '-segment_list_entry_prefix',
      this.baseStreamUrl,
      this.segmentTemplate,
    );

    return opts;
  }
}
