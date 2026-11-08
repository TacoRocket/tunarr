import type { TranscodeConfig } from '@tunarr/types';
import type { SupportedTranscodeAudioOutputFormats } from '@tunarr/types/schemas';

/**
 * SIGNPOST(native-retirement): the Next-only filters and checks built on this go once a profile
 * can no longer name a format the worker can't produce.
 *
 * Audio formats the ErsatzTV next worker can produce: it encodes AAC or AC-3,
 * or copies the source. Mirrors findUnsupportedSettings on the server.
 */
export const NextAudioFormats = new Set<SupportedTranscodeAudioOutputFormats>([
  'aac',
  'ac3',
  'copy',
]);

/**
 * Sample rates, in kHz as profiles store them, that FFmpeg's AC-3 encoder
 * accepts. Anything else fails to open the encoder on either engine.
 */
export const Ac3SampleRatesKhz = [32, 44.1, 48] as const;

/** AC-3 carries at most 5.1. */
export const Ac3MaxChannels = 6;

/**
 * Values that leave the settings ErsatzTV next doesn't use at rest, applied
 * when a new profile hides them again.
 */
export const NextNeutralSettings = {
  threadCount: 0,
  audioVolumePercent: 100,
  normalizeFrameRate: false,
  disableHardwareDecoder: false,
  disableHardwareEncoding: false,
  disableHardwareFilters: false,
} as const;

/**
 * Whether ErsatzTV next can play a profile, mirroring findUnsupportedSettings
 * on the server: the worker encodes every video format and acceleration mode a
 * profile can name, so audio decides.
 */
export function isNextPlayable(
  profile: Pick<
    TranscodeConfig,
    'audioFormat' | 'audioSampleRate' | 'audioChannels'
  >,
): boolean {
  if (!NextAudioFormats.has(profile.audioFormat)) return false;
  if (profile.audioFormat !== 'ac3') return true;
  return (
    (Ac3SampleRatesKhz as readonly number[]).includes(
      Number(profile.audioSampleRate),
    ) && Number(profile.audioChannels) <= Ac3MaxChannels
  );
}
