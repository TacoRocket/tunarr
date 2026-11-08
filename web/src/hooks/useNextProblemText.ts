import { useLingui } from '@lingui/react/macro';

const FormatNames: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  libopus: 'Opus',
  mp3: 'MP3',
};

/**
 * SIGNPOST(native-retirement): goes with the notices that use it.
 *
 * Plain wording for why ErsatzTV next can't play a profile ("E-AC-3 audio",
 * "24 kHz AC-3 audio"), from the server's compatibility check or its client
 * mirror, so every screen says it the same way.
 */
export function useNextProblemText() {
  const { t } = useLingui();
  const settingNames: Record<string, string> = {
    audioFormat: t`audio`,
    videoFormat: t`video`,
    hardwareAccelerationMode: t`hardware acceleration`,
    audioSampleRate: t`kHz AC-3 audio`,
    audioChannels: t`AC-3 audio channels`,
  };
  return (problems: readonly { field: string; value: string }[]) =>
    problems
      .map(
        ({ field, value }) =>
          `${FormatNames[value] ?? value} ${settingNames[field] ?? field}`,
      )
      .join(', ');
}
