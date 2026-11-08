import { RouterButtonLink } from '@/components/base/RouterButtonLink.tsx';
import type { useSeedChannelPlayback } from '@/hooks/useSeedChannelPlayback.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Alert, AlertTitle } from '@mui/material';

const FormatNames: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  libopus: 'Opus',
  mp3: 'MP3',
};

type Props = {
  channelId: string;
} & ReturnType<typeof useSeedChannelPlayback>;

export function SeedChannelPlaybackNotice({
  channelId,
  blocked,
  unsupported,
  profileName,
}: Props) {
  const { t } = useLingui();
  if (!blocked) return null;

  const settingNames: Record<string, string> = {
    audioFormat: t`audio`,
    videoFormat: t`video`,
    hardwareAccelerationMode: t`hardware acceleration`,
  };
  const settings = unsupported
    .map(
      ({ field, value }) =>
        `${FormatNames[value] ?? value} ${settingNames[field] ?? field}`,
    )
    .join(', ');
  const audio = unsupported.some(({ field }) => field === 'audioFormat');

  return (
    <Alert
      severity="warning"
      action={
        <RouterButtonLink
          to="/channels/$channelId/edit"
          params={{ channelId }}
          search={{ tab: 'ffmpeg' }}
          color="inherit"
          size="small"
          sx={{ whiteSpace: 'nowrap' }}
        >
          <Trans>Change profile</Trans>
        </RouterButtonLink>
      }
    >
      <AlertTitle>
        <Trans>This channel needs a different transcode profile</Trans>
      </AlertTitle>
      {profileName ? (
        <Trans>
          Generated programming plays through ErsatzTV next, which can't encode
          the {settings} in this channel's profile, “{profileName}”.
        </Trans>
      ) : (
        <Trans>
          Generated programming plays through ErsatzTV next, which can't encode
          the {settings} in this channel's profile.
        </Trans>
      )}{' '}
      {audio && (
        <Trans>
          Switch the channel to a profile with AAC, AC-3 or copied audio.
        </Trans>
      )}{' '}
      <Trans>You can still preview lineups here.</Trans>
    </Alert>
  );
}
