import path from 'node:path';
import type { ChannelOfflineSettings } from '../../db/schema/base.ts';
import type { ChannelOrm } from '../../db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '../../db/schema/TranscodeConfig.ts';
import { crtWorkerStage } from '../../ffmpeg/builder/filter/crt/CrtFilter.ts';
import { usesCrtHardwareProcessing } from '../../ffmpeg/builder/filter/crt/processingTier.ts';
import type { IgnoredSetting } from './EtvNextChannelConfigMapper.ts';
import type {
  AudioNormalizationConfig,
  ChannelConfig,
  CustomShaderOptionsConfig,
  HardwareAccel,
  VideoNormalizationConfig,
} from './generated/channelConfig.ts';
import { FrameSize } from '../../ffmpeg/builder/types.ts';
import { bundledImagePath, uploadedImagePath } from '../../forkResources.ts';
import { isNonEmptyString } from '../../util/index.ts';

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
  if (config.normalization.audio?.mode === 'copy') {
    forkCopiedAudioFallback(config.normalization.audio);
  }
  return ignored;
}

// Copied audio follows Tunarr's own passthrough, which converts what HLS can't
// carry (FLAC, TrueHD, DTS) to AC-3 and keeps the source's surround. The worker
// encodes the items it can't copy with these settings: AC-3, with no channel
// count, bitrate or sample rate, so FFmpeg keeps the source layout (AC-3 stops
// at 5.1) and a rate AC-3 can carry (32, 44.1 or 48 kHz), at the AC-3
// encoder's bitrate for that layout. A profile's 96 kHz would make the AC-3
// encoder refuse the item. The profile's own format, channels, bitrate and
// sample rate still apply when audio is transcoded, as on Tunarr's pipeline.
function forkCopiedAudioFallback(audio: AudioNormalizationConfig) {
  audio.format = 'ac3';
  delete audio.channels;
  delete audio.bitrate_kbps;
  delete audio.buffer_kbps;
  delete audio.sample_rate_hz;
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

// A live feed's drops look like the channel going offline. When the feed stops,
// the worker plays its fallback until it can ask Tunarr for the feed again
// (`fallback.duration_seconds`). Upstream's fallback burns the failure reason
// into black, which on a live feed reads as a broken channel, so a live feed
// shows the channel's offline picture instead: the screen Tunarr's own pipeline
// shows when a channel has nothing to play. The worker reads only local files,
// so an uploaded picture is resolved to its file and any other URL uses
// Tunarr's generic offline screen. The worker still reports each fallback for
// the sessions API. Library channels keep upstream's fallback.
export function forkLiveFeedFallback(
  config: ChannelConfig,
  offline: Pick<ChannelOfflineSettings, 'picture'> | undefined,
  databaseDirectory: () => string,
) {
  config.fallback = {
    ...config.fallback,
    show_error: false,
    background_image: liveFeedOfflinePicture(
      offline?.picture,
      databaseDirectory,
    ),
  };
}

function liveFeedOfflinePicture(
  picture: string | undefined,
  databaseDirectory: () => string,
) {
  if (isNonEmptyString(picture)) {
    const uploaded = uploadedImagePath(picture, databaseDirectory);
    if (uploaded) {
      return uploaded;
    }
    if (path.isAbsolute(picture)) {
      return picture;
    }
  }
  return bundledImagePath('generic-offline-screen.png');
}
