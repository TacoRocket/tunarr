import {
  getApiChannelsByIdExperimentalLiveRelayOptions,
  putApiChannelsByIdExperimentalLiveRelayMutation,
} from '@/generated/@tanstack/react-query.gen.ts';
import type { GetApiChannelsByIdExperimentalLiveRelayResponse } from '@/generated/types.gen.ts';
import { invalidateTaggedQueries } from '@/helpers/queryUtil.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

type Feed =
  NonNullable<GetApiChannelsByIdExperimentalLiveRelayResponse>['feed'];

export function ChannelLiveRelaySettings({
  channelId,
  hasUnsavedChanges,
}: {
  channelId: string;
  hasUnsavedChanges: boolean;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const options = getApiChannelsByIdExperimentalLiveRelayOptions({
    path: { id: channelId },
  });
  const relay = useQuery(options);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Feed | 'off'>('off');
  const feeds: Record<Feed, string> = {
    est: t`Toonami Aftermath East`,
    pst: t`Toonami Aftermath West`,
    'snick-est': t`Snickelodeon East`,
    'snick-pst': t`Snickelodeon West`,
    mtv97: t`MTV97`,
    movies: t`Movies`,
    radio: t`Toonami Aftermath Radio`,
  };
  const save = useMutation({
    ...putApiChannelsByIdExperimentalLiveRelayMutation(),
    onSuccess: async (data) => {
      queryClient.setQueryData(options.queryKey, data);
      await queryClient.invalidateQueries({
        predicate: invalidateTaggedQueries('Channels'),
      });
      setOpen(false);
      snackbar.enqueueSnackbar(t`Live feed saved`, { variant: 'success' });
    },
  });

  return (
    <Stack spacing={2} sx={{ mb: 3 }}>
      <Typography variant="h6">
        <Trans>Live feed (experimental)</Trans>
      </Typography>
      <Typography variant="body2">
        <Trans>
          Play a Toonami Aftermath feed instead of library programming. Use an
          empty, standalone channel. Choose HLS to transcode, or ErsatzTV next
          with HLS Direct v2 to keep the source video and audio when compatible.
        </Trans>
      </Typography>
      {relay.isError ? (
        <Alert
          severity="error"
          action={
            <Button type="button" onClick={() => void relay.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          }
        >
          <Trans>Could not load the saved live feed.</Trans>
        </Alert>
      ) : relay.isSuccess ? (
        <Typography variant="body2">
          <Trans>Saved feed:</Trans>{' '}
          {relay.data?.feed ? feeds[relay.data.feed] : t`Off`}
        </Typography>
      ) : (
        <Typography variant="body2">
          <Trans>Loading live feed…</Trans>
        </Typography>
      )}
      {hasUnsavedChanges && (
        <Typography variant="body2">
          <Trans>
            Save or discard channel changes before configuring the live feed.
          </Trans>
        </Typography>
      )}
      <Button
        type="button"
        variant="outlined"
        sx={{ alignSelf: 'flex-start' }}
        disabled={!relay.isSuccess || hasUnsavedChanges}
        onClick={() => {
          setSelection(relay.data?.feed ?? 'off');
          save.reset();
          setOpen(true);
        }}
      >
        <Trans>Configure live feed</Trans>
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!save.isPending) setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="live-feed-title"
      >
        <DialogTitle id="live-feed-title">
          <Trans>Configure live feed</Trans>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              <Trans>
                Stop viewers before changing this setting. Saving does not
                restart active playback. This setting saves separately from
                other channel settings.
              </Trans>
            </Typography>
            <TextField
              id="live-feed-selection"
              select
              fullWidth
              label={t`Live feed`}
              value={selection}
              disabled={save.isPending}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'off' || Object.keys(feeds).includes(value))
                  setSelection(value as Feed | 'off');
                save.reset();
              }}
            >
              <MenuItem value="off">
                <Trans>Off — use channel programming</Trans>
              </MenuItem>
              {Object.entries(feeds).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2">
              <Trans>
                West feeds are delayed three hours. Some feeds may be
                unavailable through the public endpoint. The guide uses the
                source schedule where available, with the channel's usual
                placeholder title otherwise.
              </Trans>
            </Typography>
            <Typography variant="body2">
              <Trans>
                Disable the live feed before adding programs or a schedule. Your
                channel name, number, icon and streaming profile stay the same.
              </Trans>
            </Typography>
            {save.isError && (
              <Alert severity="error">
                {save.error.response?.data?.message ??
                  t`Could not save the live feed. Try again.`}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => setOpen(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            variant="contained"
            loading={save.isPending}
            disabled={selection === (relay.data?.feed ?? 'off')}
            onClick={() =>
              save.mutate({
                path: { id: channelId },
                body:
                  selection === 'off'
                    ? null
                    : { source: 'toonami-aftermath', feed: selection },
              })
            }
          >
            <Trans>Save live feed</Trans>
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
