import { RouterLink } from '@/components/base/RouterLink.tsx';
import { getApiErrorMessage } from '@/helpers/apiError.ts';
import { channelSettingsUpdate } from '@/helpers/channelSettingsUpdate.ts';
import { useNextProblemText } from '@/hooks/useNextProblemText.ts';
import type { useSeedChannelPlayback } from '@/hooks/useSeedChannelPlayback.ts';
import { useUpdateChannel } from '@/hooks/useUpdateChannel.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';

type Props = ReturnType<typeof useSeedChannelPlayback>;

/**
 * SIGNPOST(native-retirement): remove once a profile ErsatzTV next can't play can no longer be
 * chosen; until then this is how a channel on one gets out.
 *
 * Shown in the generation dialog when the channel's transcode profile can't
 * play on ErsatzTV next. The fix happens here, so the dialog (and the preview
 * the user may already have generated) stays open: only profiles Next can play
 * are offered, and choosing one saves it to the channel straight away.
 */
export function SeedChannelPlaybackNotice({
  channel,
  blocked,
  unsupported,
  profileName,
  profilesLoaded,
  compatibleProfiles,
}: Props) {
  const { t } = useLingui();
  const describe = useNextProblemText();
  const updateChannel = useUpdateChannel();
  const [choice, setChoice] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  if (!blocked || !channel) return null;

  const settings = describe(unsupported);
  const selected =
    choice ??
    (
      compatibleProfiles.find((profile) => profile.isDefault) ??
      compatibleProfiles[0]
    )?.id;

  const switchProfile = async () => {
    if (!selected) return;
    setSaveError(undefined);
    try {
      await updateChannel.mutateAsync({
        path: { id: channel.id },
        body: {
          ...channelSettingsUpdate(channel),
          transcodeConfigId: selected,
        },
      });
    } catch (error) {
      setSaveError(
        getApiErrorMessage(error) ??
          (error instanceof Error ? error.message : String(error)),
      );
    }
  };

  return (
    <Alert severity="warning">
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
      )}
      {profilesLoaded && compatibleProfiles.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ sm: 'center' }}
          >
            <TextField
              select
              size="small"
              label={t`Switch this channel to`}
              value={selected ?? ''}
              onChange={(event) => setChoice(event.target.value)}
              disabled={updateChannel.isPending}
              sx={{ minWidth: 280 }}
            >
              {compatibleProfiles.map((profile) => (
                <MenuItem key={profile.id} value={profile.id}>
                  {profile.name}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="outlined"
              color="inherit"
              disabled={!selected || updateChannel.isPending}
              onClick={() => void switchProfile()}
            >
              {updateChannel.isPending ? (
                <Trans>Switching…</Trans>
              ) : (
                <Trans>Use this profile</Trans>
              )}
            </Button>
          </Stack>
          <Typography variant="caption" component="p" sx={{ mt: 0.5 }}>
            <Trans>
              Only profiles ErsatzTV next can play are listed. Your preview
              stays here.
            </Trans>
          </Typography>
        </Box>
      )}
      {profilesLoaded && compatibleProfiles.length === 0 && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          <Trans>
            None of your transcode profiles work with ErsatzTV next yet.{' '}
            <RouterLink
              to="/profiles/transcode/new"
              target="_blank"
              rel="noopener"
            >
              Create one in a new tab
            </RouterLink>
            ; it shows up here when you come back.
          </Trans>
        </Typography>
      )}
      {saveError && (
        <Typography variant="body2" color="error" sx={{ mt: 1 }}>
          {saveError}
        </Typography>
      )}
    </Alert>
  );
}
