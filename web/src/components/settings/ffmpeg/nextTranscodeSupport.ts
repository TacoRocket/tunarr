import type { SupportedTranscodeAudioOutputFormats } from '@tunarr/types/schemas';

/**
 * Audio formats the ErsatzTV next worker can produce: it encodes AAC or AC-3,
 * or copies the source. Mirrors findUnsupportedSettings on the server.
 */
export const NextAudioFormats = new Set<SupportedTranscodeAudioOutputFormats>([
  'aac',
  'ac3',
  'copy',
]);

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
