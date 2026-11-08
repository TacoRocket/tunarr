import type { ChannelStreamMode, TranscodeConfig } from '@tunarr/types';
import type { SupportedTranscodeAudioOutputFormats } from '@tunarr/types/schemas';

/**
 * Stream modes the ErsatzTV next worker can serve. Mirrors
 * `EtvNextRoutableModes` in `server/src/stream/etv/EtvNextRouting.ts`.
 */
export const EtvNextRoutableModes: ChannelStreamMode[] = [
  'hls',
  'hls_direct_v2',
  'mpegts',
];

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

export type NextProfileProblem = { field: string; value: string };

/**
 * The settings that stop ErsatzTV next from playing a profile, mirroring
 * findUnsupportedSettings on the server. The worker encodes every video format
 * and acceleration mode a profile can name, so only audio can stop it: a format
 * it can't produce, or AC-3 outside the rates and channel count its encoder
 * accepts.
 */
export function nextProfileProblems(
  profile: Pick<
    TranscodeConfig,
    'audioFormat' | 'audioSampleRate' | 'audioChannels'
  >,
): NextProfileProblem[] {
  if (!NextAudioFormats.has(profile.audioFormat)) {
    return [{ field: 'audioFormat', value: profile.audioFormat }];
  }
  if (profile.audioFormat !== 'ac3') return [];
  const problems: NextProfileProblem[] = [];
  if (
    !(Ac3SampleRatesKhz as readonly number[]).includes(
      Number(profile.audioSampleRate),
    )
  ) {
    problems.push({
      field: 'audioSampleRate',
      value: String(profile.audioSampleRate),
    });
  }
  if (Number(profile.audioChannels) > Ac3MaxChannels) {
    problems.push({
      field: 'audioChannels',
      value: String(profile.audioChannels),
    });
  }
  return problems;
}

export function isNextPlayable(
  profile: Parameters<typeof nextProfileProblems>[0],
): boolean {
  return nextProfileProblems(profile).length === 0;
}
